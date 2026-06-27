/**
 * Local full-control session client.
 *
 * Standalone counterpart to the relay {@link GuestClient}: same authoritative
 * snapshot + `useSyncExternalStore` shape, but a plaintext {@link LocalSocket}
 * transport and the richer web control surface (slash commands, models,
 * thinking, compaction, MCP status, extension UI dialogs, extension panels).
 * It deliberately re-implements the host-frame reducer rather than sharing the
 * relay guest's, so the local UI can evolve its rendering independently while
 * the wire protocol stays the single source of truth.
 */

import type {
	AgentSnapshot,
	AssistantMessage,
	HostFrame,
	SessionEntry,
	SessionHeader,
	SessionState,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
} from "@oh-my-pi/pi-wire";
import { COLLAB_PROTO } from "@oh-my-pi/pi-wire";
import type {
	WebCapabilities,
	WebControlFrame,
	WebExtPanel,
	WebExtUIRequest,
	WebExtUIResponse,
	WebMcpServerStatus,
	WebModelInfo,
	WebSlashCommand,
	WebToolApprovalDecision,
	WebToolApprovalRequest,
} from "@oh-my-pi/pi-wire/web";
import type { ActiveTool, ConnectionPhase, GuestSnapshot, Notice } from "./client";
import { type LocalInbound, LocalSocket } from "./local-socket";

/** Authoritative local snapshot: the relay guest's viewing fields + control state. */
export interface LocalSnapshot extends GuestSnapshot {
	connected: boolean;
	capabilities: WebCapabilities | null;
	commands: readonly WebSlashCommand[];
	models: readonly WebModelInfo[];
	mcp: readonly WebMcpServerStatus[];
	/** Slash-command stdout (e.g. /help, /mcp list), newest last, capped. */
	commandOutput: readonly string[];
	/** Head of the pending tool-approval queue, or null. */
	pendingApproval: WebToolApprovalRequest | null;
	/** Head of the pending extension-UI dialog queue, or null. */
	pendingExtUI: WebExtUIRequest | null;
	extPanels: readonly WebExtPanel[];
}

const MAX_NOTICES = 50;
const MAX_COMMAND_OUTPUT = 200;
const TRANSCRIPT_TIMEOUT_MS = 10_000;

interface PendingTranscript {
	resolve: (result: { text: string; newSize: number } | null) => void;
	timer: ReturnType<typeof setTimeout>;
}
interface PendingCtl {
	resolve: (data: unknown) => void;
	reject: (error: Error) => void;
}

export type PanelMessageListener = (panelId: string, data: unknown) => void;

export class LocalClient {
	readonly #socket: LocalSocket;
	readonly #name: string;
	readonly #listeners = new Set<() => void>();
	readonly #pendingTranscripts = new Map<number, PendingTranscript>();
	readonly #pendingCtl = new Map<number, PendingCtl>();
	readonly #panelListeners = new Set<PanelMessageListener>();
	#reqSeq = 0;
	#noticeSeq = 0;
	#everConnected = false;

	#phase: ConnectionPhase = "connecting";
	#connected = false;
	#endedReason: string | null = null;
	#header: SessionHeader | null = null;
	#entries: readonly SessionEntry[] = [];
	#state: SessionState | null = null;
	#agents: readonly AgentSnapshot[] = [];
	#progress: ReadonlyMap<string, SubagentProgressPayload> = new Map();
	#lifecycle: ReadonlyMap<string, SubagentLifecyclePayload> = new Map();
	#stream: AssistantMessage | null = null;
	#streamDone = false;
	#activeTools: ReadonlyMap<string, ActiveTool> = new Map();
	#working = false;
	#readOnly = false;
	#notices: readonly Notice[] = [];

	#capabilities: WebCapabilities | null = null;
	#commands: readonly WebSlashCommand[] = [];
	#models: readonly WebModelInfo[] = [];
	#mcp: readonly WebMcpServerStatus[] = [];
	#commandOutput: readonly string[] = [];
	#extUiQueue: WebExtUIRequest[] = [];
	#approvalQueue: WebToolApprovalRequest[] = [];
	#extPanels: readonly WebExtPanel[] = [];

	#snapshot: LocalSnapshot;

	constructor(config: { wsUrl: string; name: string }) {
		this.#name = config.name;
		this.#socket = new LocalSocket({ url: config.wsUrl });
		this.#socket.onOpen = () => this.#handleOpen();
		this.#socket.onMessage = frame => this.#applyFrameSafe(frame);
		this.#socket.onClose = (reason, willReconnect) => this.#handleClose(reason, willReconnect);
		this.#snapshot = this.#buildSnapshot();
	}

	connect(): void {
		this.#socket.connect();
	}

	close(): void {
		this.#socket.close();
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	getSnapshot(): LocalSnapshot {
		return this.#snapshot;
	}
	/** Test seam: apply a synthetic host frame through the real apply path. */
	applyFrameForTest(frame: LocalInbound): void {
		this.#applyFrameSafe(frame);
	}

	/** Subscribe to host→panel messages (Tier-2 extension panels). */
	onPanelMessage(listener: PanelMessageListener): () => void {
		this.#panelListeners.add(listener);
		return () => {
			this.#panelListeners.delete(listener);
		};
	}

	// ── Steer (collab GuestFrames) ────────────────────────────────────────────

	sendAbort(): void {
		this.#socket.send({ t: "abort" });
	}

	sendAgentCmd(cmd: "chat" | "kill" | "revive", agentId: string, text?: string): void {
		this.#socket.send({ t: "agent-cmd", cmd, agentId, text });
	}

	fetchTranscript(agentId: string, fromByte: number): Promise<{ text: string; newSize: number } | null> {
		const reqId = ++this.#reqSeq;
		const { promise, resolve } = Promise.withResolvers<{ text: string; newSize: number } | null>();
		const timer = setTimeout(() => {
			this.#pendingTranscripts.delete(reqId);
			resolve(null);
		}, TRANSCRIPT_TIMEOUT_MS);
		this.#pendingTranscripts.set(reqId, { resolve, timer });
		this.#socket.send({ t: "fetch-transcript", reqId, agentId, fromByte });
		return promise;
	}

	// ── Control ops (WebControlFrame, reqId/ctl-ack correlated) ───────────────

	#ctl<T = unknown>(make: (reqId: number) => Extract<WebControlFrame, { t: "ctl" }>): Promise<T> {
		const reqId = ++this.#reqSeq;
		const { promise, resolve, reject } = Promise.withResolvers<T>();
		this.#pendingCtl.set(reqId, { resolve: value => resolve(value as T), reject });
		this.#socket.send(make(reqId));
		return promise;
	}

	prompt(text: string, behavior?: "steer" | "followUp"): Promise<unknown> {
		return this.#ctl(reqId => ({ t: "ctl", op: "prompt", reqId, text, streamingBehavior: behavior }));
	}
	runSlash(command: string): Promise<unknown> {
		return this.#ctl(reqId => ({ t: "ctl", op: "slash", reqId, command }));
	}
	setModel(provider: string, modelId: string): Promise<unknown> {
		return this.#ctl(reqId => ({ t: "ctl", op: "set-model", reqId, provider, modelId }));
	}
	cycleModel(): Promise<unknown> {
		return this.#ctl(reqId => ({ t: "ctl", op: "cycle-model", reqId }));
	}
	setThinking(level: string): Promise<unknown> {
		return this.#ctl(reqId => ({ t: "ctl", op: "set-thinking", reqId, level }));
	}
	cycleThinking(): Promise<unknown> {
		return this.#ctl(reqId => ({ t: "ctl", op: "cycle-thinking", reqId }));
	}
	compact(instructions?: string): Promise<unknown> {
		return this.#ctl(reqId => ({ t: "ctl", op: "compact", reqId, instructions }));
	}
	setSessionName(name: string): Promise<unknown> {
		return this.#ctl(reqId => ({ t: "ctl", op: "set-session-name", reqId, name }));
	}
	branch(entryId: string): Promise<unknown> {
		return this.#ctl(reqId => ({ t: "ctl", op: "branch", reqId, entryId }));
	}
	bash(command: string): Promise<unknown> {
		return this.#ctl(reqId => ({ t: "ctl", op: "bash", reqId, command }));
	}
	respondApproval(approvalId: string, decision: WebToolApprovalDecision): Promise<unknown> {
		return this.#ctl(reqId => ({ t: "ctl", op: "tool-approval", reqId, approvalId, decision }));
	}

	respondExtUI(response: WebExtUIResponse): void {
		this.#socket.send({ t: "ext-ui-response", response });
		if (this.#extUiQueue[0]?.id === response.id) {
			this.#extUiQueue = this.#extUiQueue.slice(1);
			this.#commit();
		}
	}

	sendPanelMessage(panelId: string, data: unknown): void {
		this.#socket.send({ t: "ext-panel-message", panelId, data });
	}

	// ── Lifecycle ──────────────────────────────────────────────────────────────

	#handleOpen(): void {
		this.#socket.send({ t: "hello", proto: COLLAB_PROTO, name: this.#name });
		this.#connected = true;
		this.#phase = this.#everConnected ? "reconnecting" : "waiting";
		this.#everConnected = true;
		this.#commit();
	}

	#handleClose(reason: string, willReconnect: boolean): void {
		this.#connected = false;
		if (this.#phase === "ended") return;
		this.#phase = willReconnect ? "reconnecting" : "ended";
		if (!willReconnect) {
			this.#endedReason = reason;
			for (const [, pending] of this.#pendingTranscripts) {
				clearTimeout(pending.timer);
				pending.resolve(null);
			}
			this.#pendingTranscripts.clear();
		}
		this.#commit();
	}

	#applyFrameSafe(frame: LocalInbound): void {
		try {
			this.#applyFrame(frame);
		} catch (err) {
			this.#pushNotice(
				"error",
				`failed to apply ${frame.t} frame: ${err instanceof Error ? err.message : String(err)}`,
			);
			this.#commit();
		}
	}

	#applyFrame(frame: LocalInbound): void {
		switch (frame.t) {
			case "welcome":
				this.#header = frame.header;
				this.#entries = [];
				this.#state = frame.state;
				this.#agents = [...frame.agents];
				this.#stream = null;
				this.#streamDone = false;
				this.#activeTools = new Map();
				this.#working = frame.state.isStreaming;
				this.#readOnly = frame.readOnly === true;
				this.#phase = frame.entryCount === 0 ? "live" : "waiting";
				this.#endedReason = null;
				break;
			case "snapshot-chunk":
				this.#entries = [...this.#entries, ...frame.entries];
				if (frame.final) this.#phase = "live";
				break;
			case "entry":
				this.#entries = [...this.#entries, frame.entry];
				if (this.#streamDone && frame.entry.type === "message" && frame.entry.message.role === "assistant") {
					this.#stream = null;
					this.#streamDone = false;
				}
				break;
			case "event":
				this.#applyEvent(frame.event);
				break;
			case "state":
				this.#state = frame.state;
				if (!frame.state.isStreaming) {
					this.#working = false;
					if (this.#streamDone) {
						this.#stream = null;
						this.#streamDone = false;
					}
				}
				break;
			case "agents":
				this.#agents = [...frame.agents];
				break;
			case "bus":
				if (frame.channel === "task:subagent:progress") {
					const payload = frame.data as SubagentProgressPayload;
					this.#progress = new Map(this.#progress).set(payload.progress.id, payload);
				} else if (frame.channel === "task:subagent:lifecycle") {
					const payload = frame.data as SubagentLifecyclePayload;
					this.#lifecycle = new Map(this.#lifecycle).set(payload.id, payload);
				}
				break;
			case "transcript": {
				const pending = this.#pendingTranscripts.get(frame.reqId);
				if (pending) {
					this.#pendingTranscripts.delete(frame.reqId);
					clearTimeout(pending.timer);
					pending.resolve(frame.error !== undefined ? null : { text: frame.text, newSize: frame.newSize });
				}
				break;
			}
			case "bye":
				this.#handleClose(frame.reason, false);
				return;
			case "error":
				this.#pushNotice("error", frame.message);
				break;
			// ── Control events ────────────────────────────────────────────────
			case "capabilities":
				this.#capabilities = frame.capabilities;
				this.#readOnly = !frame.capabilities.canWrite;
				break;
			case "commands":
				this.#commands = frame.commands;
				break;
			case "models":
				this.#models = frame.models;
				break;
			case "mcp":
				this.#mcp = frame.servers;
				break;
			case "command-output":
				this.#commandOutput = [...this.#commandOutput, frame.text].slice(-MAX_COMMAND_OUTPUT);
				break;
			case "tool-approval-request":
				this.#approvalQueue = [...this.#approvalQueue, frame.request];
				break;
			case "tool-approval-cancel":
				this.#approvalQueue = this.#approvalQueue.filter(a => a.id !== frame.approvalId);
				break;
			case "ext-ui-request":
				this.#applyExtUIRequest(frame.request);
				break;
			case "ext-panels":
				this.#extPanels = frame.panels;
				break;
			case "ext-panel-message":
				for (const listener of this.#panelListeners) listener(frame.panelId, frame.data);
				break;
			case "ctl-ack": {
				const pending = this.#pendingCtl.get(frame.reqId);
				if (pending) {
					this.#pendingCtl.delete(frame.reqId);
					if (frame.ok) pending.resolve(frame.data);
					else pending.reject(new Error(frame.error));
				}
				break;
			}
			default:
				break;
		}
		this.#commit();
	}

	#applyExtUIRequest(request: WebExtUIRequest): void {
		switch (request.method) {
			case "select":
			case "confirm":
			case "input":
			case "editor":
				this.#extUiQueue = [...this.#extUiQueue, request];
				break;
			case "notify":
				this.#pushNotice(request.notifyType ?? "info", request.message);
				break;
			case "setTitle":
				document.title = request.title;
				break;
			case "open_url":
				window.open(request.url, "_blank", "noopener");
				break;
			case "cancel":
				this.#extUiQueue = this.#extUiQueue.filter(q => q.id !== request.targetId);
				break;
			default:
				// setStatus / setWidget / set_editor_text — no web surface in v1
				break;
		}
	}

	#applyEvent(event: Extract<HostFrame, { t: "event" }>["event"]): void {
		switch (event.type) {
			case "message_start":
			case "message_update":
				if (event.message.role === "assistant") {
					this.#stream = event.message;
					this.#streamDone = false;
				}
				break;
			case "message_end":
				if (event.message.role === "assistant") {
					this.#stream = event.message;
					this.#streamDone = true;
				}
				break;
			case "tool_execution_start":
				this.#activeTools = new Map(this.#activeTools).set(event.toolCallId, {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
					intent: event.intent,
					startedAt: Date.now(),
				});
				break;
			case "tool_execution_update": {
				const existing = this.#activeTools.get(event.toolCallId);
				this.#activeTools = new Map(this.#activeTools).set(event.toolCallId, {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
					intent: existing?.intent,
					partialResult: event.partialResult,
					startedAt: existing?.startedAt ?? Date.now(),
				});
				break;
			}
			case "tool_execution_end": {
				const next = new Map(this.#activeTools);
				next.delete(event.toolCallId);
				this.#activeTools = next;
				break;
			}
			case "agent_start":
				this.#working = true;
				break;
			case "agent_end":
				this.#working = false;
				break;
			case "notice":
				this.#pushNotice(event.level, event.message);
				break;
			case "auto_retry_start":
				this.#pushNotice("info", `retry ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}`);
				break;
			case "auto_compaction_start":
				this.#pushNotice("info", `compacting context (${event.reason})`);
				break;
			case "auto_compaction_end":
				if (!event.skipped) {
					this.#pushNotice(
						"info",
						event.aborted
							? "compaction aborted"
							: event.errorMessage
								? `compaction failed: ${event.errorMessage}`
								: "context compacted",
					);
				}
				break;
			default:
				break;
		}
	}

	#pushNotice(level: Notice["level"], message: string): void {
		const notice: Notice = { id: ++this.#noticeSeq, level, message, at: Date.now() };
		this.#notices = [...this.#notices, notice].slice(-MAX_NOTICES);
	}

	#buildSnapshot(): LocalSnapshot {
		return {
			phase: this.#phase,
			endedReason: this.#endedReason,
			header: this.#header,
			entries: this.#entries,
			state: this.#state,
			agents: this.#agents,
			progress: this.#progress,
			lifecycle: this.#lifecycle,
			stream: this.#stream,
			streamDone: this.#streamDone,
			activeTools: this.#activeTools,
			working: this.#working,
			readOnly: this.#readOnly,
			notices: this.#notices,
			connected: this.#connected,
			capabilities: this.#capabilities,
			commands: this.#commands,
			models: this.#models,
			mcp: this.#mcp,
			commandOutput: this.#commandOutput,
			pendingApproval: this.#approvalQueue[0] ?? null,
			pendingExtUI: this.#extUiQueue[0] ?? null,
			extPanels: this.#extPanels,
		};
	}

	#commit(): void {
		this.#snapshot = this.#buildSnapshot();
		for (const listener of this.#listeners) listener();
	}
}
