/**
 * SessionGateway — the transport-agnostic bridge between the UI-agnostic
 * Layer-1 core (AgentSession, SessionManager, EventBus, AgentRegistry,
 * MCPManager) and any number of {@link GatewayPeer}s.
 *
 * It is a generalization of {@link CollabHost}: the same four broadcast taps
 * (session events, appended entries, EventBus channels, agent-registry changes)
 * plus chunked snapshot replication, but with NO dependency on the TUI /
 * InteractiveModeContext and with the richer web control surface (slash
 * commands, model/thinking/compaction control, MCP status, extension UI
 * dialogs) layered on top. A peer is any duplex JSON channel; the local
 * Bun.serve WebSocket is the first consumer.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { logger, Snowflake } from "@oh-my-pi/pi-utils";
import type {
	WebCapabilities,
	WebControlEvent,
	WebControlFrame,
	WebSessionInfo,
	WebToolApprovalDecision,
	WebToolApprovalRequest,
} from "@oh-my-pi/pi-wire/web";
import { WEB_CONTROL_PROTO } from "@oh-my-pi/pi-wire/web";
import type { AgentSnapshot, CollabParticipant, CollabSessionState } from "../collab/protocol";
import { COLLAB_PROTO } from "../collab/protocol";
import type { ExtensionUIContext } from "../extensibility/extensions";
import { buildSkillPromptMessage } from "../extensibility/skills";
import type { MCPManager } from "../mcp";
import { MCP_CONNECTION_STATUS_EVENT_CHANNEL } from "../mcp/startup-events";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { type AgentRef, AgentRegistry } from "../registry/agent-registry";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import { SKILL_PROMPT_MESSAGE_TYPE, USER_INTERRUPT_LABEL } from "../session/messages";
import type { SessionEntry as StoredSessionEntry } from "../session/session-entries";
import { SessionManager } from "../session/session-manager";
import { executeAcpBuiltinSlashCommand } from "../slash-commands/acp-builtins";
import { buildAvailableSlashCommands } from "../slash-commands/available-commands";
import { lookupBuiltinSlashCommand } from "../slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "../slash-commands/types";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL, TASK_SUBAGENT_PROGRESS_CHANNEL } from "../task";
import { parseConfiguredThinkingLevel } from "../thinking";
import type { EventBus } from "../utils/event-bus";
import { type PendingExtensionUIRequest, WebExtensionUIContext } from "./extension-ui";
import { toWebMcpStatus, toWebModels, toWebSlashCommands } from "./projections";
import { applyWebSetting, buildWebSettings } from "./settings-bridge";
import type { GatewayHostFrame, GatewayInbound, GatewayOutbound, GatewayPeer } from "./types";

const STATE_DEBOUNCE_MS = 100;
const AGENTS_DEBOUNCE_MS = 100;
const STREAMING_STATE_INTERVAL_MS = 2000;
const SNAPSHOT_CHUNK_BYTES = 512 * 1024;
const TRANSCRIPT_READ_CAP = 4 * 1024 * 1024;

/** AgentSessionEvent types mirrored to peers verbatim (the wire AgentEvent subset). */
const WIRE_AGENT_EVENT_TYPES = new Set<AgentSessionEvent["type"]>([
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"notice",
	"auto_compaction_start",
	"auto_compaction_end",
	"auto_retry_start",
	"auto_retry_end",
	"thinking_level_changed",
]);

/** SessionEntry types broadcast as durable transcript rows. */
const WIRE_SESSION_ENTRY_TYPES = new Set<StoredSessionEntry["type"]>([
	"message",
	"custom_message",
	"compaction",
	"branch_summary",
	"model_change",
	"thinking_level_change",
]);

/** Events that should refresh the debounced footer state. */
const STATE_TRIGGER_EVENTS = new Set<AgentSessionEvent["type"]>([
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_end",
	"thinking_level_changed",
	"auto_compaction_start",
	"auto_compaction_end",
]);

export interface SessionGatewayDeps {
	session: AgentSession;
	eventBus?: EventBus;
	mcpManager?: MCPManager;
	/** Display name for the host (CLI) participant. Default "host". */
	hostName?: string;
	/** Re-discover slash commands + reload plugin state (delegated to the server). */
	reloadPlugins?: () => Promise<void>;
}

export interface PendingApproval {
	resolve: (decision: WebToolApprovalDecision) => void;
}

function isWireAgentEvent(event: AgentSessionEvent): boolean {
	return WIRE_AGENT_EVENT_TYPES.has(event.type);
}

function isWireSessionEntry(entry: StoredSessionEntry): boolean {
	return WIRE_SESSION_ENTRY_TYPES.has(entry.type);
}

export class SessionGateway {
	readonly #session: AgentSession;
	readonly #eventBus: EventBus | undefined;
	readonly #mcpManager: MCPManager | undefined;
	readonly #hostName: string;
	readonly #reloadPlugins: (() => Promise<void>) | undefined;

	readonly #peers = new Set<GatewayPeer>();
	readonly #pendingExtUI = new Map<string, PendingExtensionUIRequest>();
	readonly #pendingApprovals = new Map<string, PendingApproval>();
	readonly #extUiContext: WebExtensionUIContext;

	#unsubscribeSession?: () => void;
	#registryUnsubscribe?: () => void;
	#busUnsubscribers: (() => void)[] = [];
	#stateDebounce: Timer | null = null;
	#agentsDebounce: Timer | null = null;
	#streamingInterval: Timer | null = null;
	#lastStateJson = "";
	#started = false;
	#stopped = false;

	constructor(deps: SessionGatewayDeps) {
		this.#session = deps.session;
		this.#eventBus = deps.eventBus;
		this.#mcpManager = deps.mcpManager;
		this.#hostName = deps.hostName ?? "host";
		this.#reloadPlugins = deps.reloadPlugins;
		this.#extUiContext = new WebExtensionUIContext(this.#pendingExtUI, request =>
			this.#broadcastControl({ t: "ext-ui-request", request }),
		);
	}

	/** The extension UI context to hand to `setToolUIContext` + `initializeExtensions`. */
	get extensionUIContext(): ExtensionUIContext {
		return this.#extUiContext;
	}

	/** Begin tapping Layer-1 state. Idempotent. */
	start(): void {
		if (this.#started) return;
		this.#started = true;
		this.#unsubscribeSession = this.#session.subscribe(event => {
			if (isWireAgentEvent(event)) this.#broadcast({ t: "event", event });
			this.#onEventForState(event);
		});
		this.#session.sessionManager.onEntryAppended = entry => {
			if (isWireSessionEntry(entry)) this.#broadcast({ t: "entry", entry });
			this.#scheduleStateBroadcast();
		};
		const bus = this.#eventBus;
		if (bus) {
			for (const channel of [TASK_SUBAGENT_PROGRESS_CHANNEL, TASK_SUBAGENT_LIFECYCLE_CHANNEL] as const) {
				this.#busUnsubscribers.push(bus.on(channel, data => this.#broadcast({ t: "bus", channel, data })));
			}
			this.#busUnsubscribers.push(bus.on(MCP_CONNECTION_STATUS_EVENT_CHANNEL, () => this.#broadcastMcp()));
		}
		this.#registryUnsubscribe = AgentRegistry.global().onChange(() => this.#scheduleAgentsBroadcast());
		this.#session.subscribeCommandMetadataChanged(() => void this.#broadcastCommands());
	}

	/** Detach all taps and drop peers. Idempotent. */
	stop(): void {
		if (this.#stopped) return;
		this.#stopped = true;
		this.#session.sessionManager.onEntryAppended = undefined;
		this.#unsubscribeSession?.();
		this.#registryUnsubscribe?.();
		for (const unsub of this.#busUnsubscribers) unsub();
		this.#busUnsubscribers = [];
		clearTimeout(this.#stateDebounce ?? undefined);
		clearTimeout(this.#agentsDebounce ?? undefined);
		clearInterval(this.#streamingInterval ?? undefined);
		this.#streamingInterval = null;
		for (const peer of this.#peers) peer.close("gateway stopped");
		this.#peers.clear();
	}

	// ── Peer lifecycle ──────────────────────────────────────────────────────

	addPeer(peer: GatewayPeer): void {
		this.#peers.add(peer);
	}

	removePeer(peer: GatewayPeer): void {
		this.#peers.delete(peer);
		this.#scheduleStateBroadcast();
	}

	/** Dispatch an inbound frame from a peer. */
	handleFrame(peer: GatewayPeer, frame: GatewayInbound): void {
		switch (frame.t) {
			case "hello":
				this.#onHello(peer, frame.name);
				return;
			case "prompt":
				if (this.#guardWrite(peer)) void this.#runPrompt(frame.text, frame.images, "steer", peer);
				return;
			case "abort":
				if (this.#guardWrite(peer)) void this.#session.abort({ reason: USER_INTERRUPT_LABEL });
				return;
			case "agent-cmd":
				if (this.#guardWrite(peer)) this.#handleAgentCmd(frame.cmd, frame.agentId, frame.text);
				return;
			case "fetch-transcript":
				void this.#handleFetchTranscript(peer, frame.reqId, frame.agentId, frame.fromByte);
				return;
			case "ext-ui-response":
				this.#pendingExtUI.get(frame.response.id)?.resolve(frame.response);
				this.#pendingExtUI.delete(frame.response.id);
				return;
			case "ext-panel-message":
				// Tier-2 panel → host-side extension; routed in the ExtensionWebUI phase.
				return;
			case "ctl":
				void this.#handleControl(peer, frame);
				return;
			default:
				logger.debug("gateway ignoring unexpected frame", { frame });
		}
	}

	#onHello(peer: GatewayPeer, name: string): void {
		peer.name = name.trim().slice(0, 64) || peer.id;
		this.#sendWelcome(peer);
		// Register for live broadcasts only AFTER the welcome + full snapshot are
		// queued on this peer's socket. Adding earlier (e.g. on WS open) lets an
		// in-flight entry/event/state frame reach a peer before its snapshot,
		// corrupting a mid-stream join. Synchronous send order guarantees no live
		// frame interleaves between the snapshot and this add.
		this.#peers.add(peer);
		if (peer.control) {
			peer.send({
				t: "capabilities",
				capabilities: {
					canWrite: peer.canWrite,
					control: peer.control,
					features: ["slash", "models", "mcp", "ext-ui", "settings"],
					proto: WEB_CONTROL_PROTO,
				} satisfies WebCapabilities,
			});
			void this.#broadcastCommands(peer);
			this.#sendModels(peer);
			this.#sendMcp(peer);
			this.#sendSettings(peer);
		}
	}

	/** Send (or re-send) the welcome + full snapshot to one peer — also used to
	 *  reset a peer's transcript after a session switch (/new). */
	#sendWelcome(peer: GatewayPeer): void {
		const snapshot = this.#session.sessionManager.snapshotForReplication();
		const entries = snapshot.entries.filter(isWireSessionEntry);
		peer.send({
			t: "welcome",
			proto: COLLAB_PROTO,
			header: snapshot.header,
			state: this.#buildState(),
			agents: this.#snapshotAgents(),
			entryCount: entries.length,
			readOnly: peer.canWrite ? undefined : true,
		});
		this.#sendSnapshotChunks(peer, entries);
	}

	#sendSnapshotChunks(peer: GatewayPeer, entries: StoredSessionEntry[]): void {
		if (entries.length === 0) {
			peer.send({ t: "snapshot-chunk", entries: [], final: true });
			return;
		}
		let i = 0;
		while (i < entries.length) {
			const batch: StoredSessionEntry[] = [];
			let bytes = 0;
			while (i < entries.length) {
				const entry = entries[i];
				if (!entry) break;
				const entryBytes = JSON.stringify(entry).length;
				if (batch.length > 0 && bytes + entryBytes > SNAPSHOT_CHUNK_BYTES) break;
				batch.push(entry);
				bytes += entryBytes;
				i++;
			}
			peer.send({ t: "snapshot-chunk", entries: batch, final: i >= entries.length });
		}
	}

	// ── Control frames ──────────────────────────────────────────────────────

	async #handleControl(peer: GatewayPeer, frame: Extract<WebControlFrame, { t: "ctl" }>): Promise<void> {
		const ack = (ok: boolean, dataOrError?: unknown) =>
			peer.send(
				ok
					? { t: "ctl-ack", reqId: frame.reqId, ok: true, data: dataOrError }
					: { t: "ctl-ack", reqId: frame.reqId, ok: false, error: String(dataOrError) },
			);
		try {
			switch (frame.op) {
				case "prompt":
					this.#requireWrite(peer);
					void this.#runPrompt(frame.text, frame.images, frame.streamingBehavior, peer);
					return ack(true);
				case "steer":
					this.#requireWrite(peer);
					await this.#session.steer(frame.text, frame.images);
					return ack(true);
				case "follow-up":
					this.#requireWrite(peer);
					await this.#session.followUp(frame.text, frame.images);
					return ack(true);
				case "abort":
					this.#requireWrite(peer);
					await this.#session.abort({ reason: USER_INTERRUPT_LABEL });
					return ack(true);
				case "slash":
					this.#requireWrite(peer);
					await this.#runSlash(frame.command, peer);
					return ack(true);
				case "set-model": {
					this.#requireWrite(peer);
					const models = this.#session.getAvailableModels();
					const model = models.find(m => m.provider === frame.provider && m.id === frame.modelId);
					if (!model) return ack(false, `Model not found: ${frame.provider}/${frame.modelId}`);
					await this.#session.setModel(model);
					this.#sendModels();
					return ack(true);
				}
				case "cycle-model":
					this.#requireWrite(peer);
					await this.#session.cycleModel(frame.direction);
					this.#sendModels();
					return ack(true);
				case "set-thinking": {
					this.#requireWrite(peer);
					const level = parseConfiguredThinkingLevel(frame.level);
					if (!level) return ack(false, `invalid thinking level: ${frame.level}`);
					this.#session.setThinkingLevel(level);
					return ack(true);
				}
				case "cycle-thinking":
					this.#requireWrite(peer);
					this.#session.cycleThinkingLevel();
					return ack(true);
				case "compact":
					this.#requireWrite(peer);
					await this.#session.compact(frame.instructions);
					return ack(true);
				case "set-session-name":
					this.#requireWrite(peer);
					await this.#session.setSessionName(frame.name, "user");
					return ack(true);
				case "branch": {
					this.#requireWrite(peer);
					const result = await this.#session.branch(frame.entryId);
					return ack(true, result);
				}
				case "bash": {
					this.#requireWrite(peer);
					const result = await this.#session.executeBash(frame.command);
					return ack(true, result);
				}
				case "abort-bash":
					this.#requireWrite(peer);
					await this.#session.abortBash();
					return ack(true);
				case "retry": {
					this.#requireWrite(peer);
					const ok = await this.#session.retry();
					return ack(true, { retried: ok });
				}
				case "get-models":
					this.#sendModels(peer);
					return ack(true);
				case "get-commands":
					await this.#broadcastCommands(peer);
					return ack(true);
				case "get-mcp":
					this.#sendMcp(peer);
					return ack(true);
				case "get-settings":
					this.#sendSettings(peer);
					return ack(true);
				case "set-setting": {
					this.#requireWrite(peer);
					const err = applyWebSetting(this.#session.settings, frame.path, frame.value);
					if (err) return ack(false, err);
					this.#sendSettings();
					this.#sendModels();
					return ack(true);
				}
				case "list-sessions":
					return ack(true, await this.#listSessions());
				case "switch-session": {
					this.#requireWrite(peer);
					const switched = await this.#session.switchSession(frame.path);
					if (switched) for (const target of this.#peers) this.#sendWelcome(target);
					return ack(true, { switched });
				}
				case "tool-approval":
					this.#pendingApprovals.get(frame.approvalId)?.resolve(frame.decision);
					this.#pendingApprovals.delete(frame.approvalId);
					return ack(true);
				default:
					return ack(false, `unknown control op`);
			}
		} catch (err) {
			ack(false, err instanceof Error ? err.message : String(err));
		}
	}

	#slashRuntime(peer: GatewayPeer): SlashCommandRuntime {
		return {
			session: this.#session,
			sessionManager: this.#session.sessionManager,
			settings: this.#session.settings,
			cwd: this.#session.sessionManager.getCwd(),
			output: text => peer.send({ t: "command-output", text }),
			refreshCommands: () => this.#broadcastCommands(),
			reloadPlugins: async () => {
				await this.#reloadPlugins?.();
				await this.#broadcastCommands();
			},
			notifyConfigChanged: () => this.#sendModels(),
		};
	}

	async #runPrompt(
		text: string,
		images: ImageContent[] | undefined,
		streamingBehavior: "steer" | "followUp" | undefined,
		peer: GatewayPeer,
	): Promise<void> {
		// A slash typed/sent as a prompt still runs as a command.
		if (text.startsWith("/")) return this.#runSlash(text, peer);
		void this.#session.prompt(text, { images, streamingBehavior });
	}

	async #runSlash(command: string, peer: GatewayPeer): Promise<void> {
		const name = command.replace(/^\/+/, "").split(/[\s:]/, 1)[0] ?? "";
		// Skill command: /skill:<name> [args]
		if (command.startsWith("/skill:") && this.#session.skillsSettings?.enableSkillCommands) {
			const spaceIndex = command.indexOf(" ");
			const skillName = (spaceIndex === -1 ? command.slice(1) : command.slice(1, spaceIndex)).slice("skill:".length);
			const args = spaceIndex === -1 ? "" : command.slice(spaceIndex + 1).trim();
			const skill = this.#session.skills.find(candidate => candidate.name === skillName);
			if (skill) {
				const built = await buildSkillPromptMessage(skill, args);
				await this.#session.promptCustomMessage({
					customType: SKILL_PROMPT_MESSAGE_TYPE,
					content: built.message,
					display: true,
					details: built.details,
					attribution: "user",
				});
				return;
			}
		}
		const result = await executeAcpBuiltinSlashCommand(command, this.#slashRuntime(peer));
		if (result !== false) {
			if ("prompt" in result) void this.#session.prompt(result.prompt);
			return;
		}
		// Web equivalents for a couple of otherwise TUI-only commands.
		if (name === "retry") {
			const ok = await this.#session.retry();
			peer.send({ t: "command-output", text: ok ? "Retrying the last turn…" : "Nothing to retry." });
			return;
		}
		if (name === "plan") {
			const on = this.#session.getPlanModeState()?.enabled === true;
			this.#session.setPlanModeState(
				on ? undefined : { enabled: true, planFilePath: "local://PLAN.md", workflow: "parallel" },
			);
			this.#scheduleStateBroadcast();
			peer.send({
				t: "command-output",
				text: on ? "Plan mode disabled." : "Plan mode enabled — draft local://PLAN.md before executing.",
			});
			return;
		}
		if (name === "new") {
			const ok = await this.#session.newSession();
			if (ok) for (const target of this.#peers) this.#sendWelcome(target);
			peer.send({ t: "command-output", text: ok ? "Started a new session." : "Could not start a new session." });
			return;
		}
		if (name === "fork") {
			const ok = await this.#session.fork();
			if (ok) for (const target of this.#peers) this.#sendWelcome(target);
			peer.send({
				t: "command-output",
				text: ok ? "Forked the session (history copied)." : "Could not fork the session.",
			});
			return;
		}
		// Not handled by the text dispatcher. A KNOWN builtin here is TUI-only (no
		// text handle) — surface that rather than send "/cmd" to the model.
		if (lookupBuiltinSlashCommand(name)) {
			peer.send({ t: "command-output", text: `/${name} is interactive-only and not yet available in the web UI.` });
			return;
		}
		// Everything else (extension/custom/file commands, or an unknown slash) goes
		// to session.prompt: it expands recognized commands and forwards the rest to
		// the model — matching the TUI/RPC behavior.
		void this.#session.prompt(command);
	}

	#handleAgentCmd(cmd: "chat" | "kill" | "revive", agentId: string, text: string | undefined): void {
		if (AgentRegistry.global().get(agentId)?.kind === "advisor") return;
		const fail = (err: unknown) => logger.warn("gateway agent-cmd failed", { cmd, agentId, error: String(err) });
		switch (cmd) {
			case "chat": {
				const trimmed = text?.trim();
				if (!trimmed) return;
				AgentLifecycleManager.global()
					.ensureLive(agentId)
					.then(session => session.prompt(trimmed, { streamingBehavior: "steer" }))
					.catch(fail);
				return;
			}
			case "kill": {
				const kill = async () => {
					const ref = AgentRegistry.global().get(agentId);
					if (ref && ref.status === "running" && ref.session) {
						await ref.session.abort({ reason: USER_INTERRUPT_LABEL });
					}
					await AgentLifecycleManager.global().release(agentId);
				};
				kill().catch(fail);
				return;
			}
			case "revive":
				AgentLifecycleManager.global().ensureLive(agentId).catch(fail);
		}
	}

	async #handleFetchTranscript(peer: GatewayPeer, reqId: number, agentId: string, fromByte: number): Promise<void> {
		const reply = (text: string, newSize: number, error?: string) =>
			peer.send({ t: "transcript", reqId, text, newSize, error });
		const file = AgentRegistry.global().get(agentId)?.sessionFile;
		if (!file) return reply("", fromByte, "no transcript available");
		try {
			const stat = await fs.stat(file);
			if (stat.size <= fromByte) return reply("", stat.size);
			const want = Math.min(stat.size - fromByte, TRANSCRIPT_READ_CAP);
			const handle = await fs.open(file, "r");
			const buf = Buffer.allocUnsafe(want);
			let bytesRead: number;
			try {
				({ bytesRead } = await handle.read(buf, 0, want, fromByte));
			} finally {
				await handle.close();
			}
			let slice = buf.subarray(0, bytesRead);
			const reachedEof = fromByte + bytesRead >= stat.size;
			if (!reachedEof) {
				const lastNewline = slice.lastIndexOf(0x0a);
				slice = slice.subarray(0, lastNewline >= 0 ? lastNewline + 1 : 0);
			}
			reply(slice.toString("utf-8"), reachedEof ? stat.size : fromByte + slice.byteLength);
		} catch (err) {
			reply("", fromByte, String(err));
		}
	}

	// ── Tool approval (wired into the tool path in the ControlParity phase) ───

	/** Request an approval decision from control peers. Resolves on their reply. */
	requestToolApproval(request: Omit<WebToolApprovalRequest, "id">): Promise<WebToolApprovalDecision> {
		const id = Snowflake.next() as string;
		const { promise, resolve } = Promise.withResolvers<WebToolApprovalDecision>();
		this.#pendingApprovals.set(id, { resolve });
		this.#broadcastControl({ t: "tool-approval-request", request: { id, ...request } });
		return promise;
	}

	// ── Broadcast helpers ─────────────────────────────────────────────────────

	#broadcast(frame: GatewayHostFrame): void {
		for (const peer of this.#peers) peer.send(frame);
	}

	#broadcastControl(frame: WebControlEvent): void {
		for (const peer of this.#peers) if (peer.control) peer.send(frame);
	}

	async #broadcastCommands(target?: GatewayPeer): Promise<void> {
		const commands = toWebSlashCommands(await buildAvailableSlashCommands(this.#session));
		const frame: GatewayOutbound = { t: "commands", commands };
		if (target) target.send(frame);
		else this.#broadcastControl(frame);
	}

	#sendModels(target?: GatewayPeer): void {
		const models = toWebModels(this.#session.getAvailableModels(), this.#session.model);
		const frame: GatewayOutbound = { t: "models", models };
		if (target) target.send(frame);
		else this.#broadcastControl(frame);
	}

	#sendMcp(target?: GatewayPeer): void {
		const frame: GatewayOutbound = { t: "mcp", servers: toWebMcpStatus(this.#mcpManager) };
		if (target) target.send(frame);
		else this.#broadcastControl(frame);
	}

	#broadcastMcp(): void {
		this.#sendMcp();
	}

	#sendSettings(target?: GatewayPeer): void {
		const frame: GatewayOutbound = { t: "settings", settings: buildWebSettings(this.#session.settings) };
		if (target) target.send(frame);
		else this.#broadcastControl(frame);
	}

	async #listSessions(): Promise<WebSessionInfo[]> {
		const sm = this.#session.sessionManager;
		const currentFile = sm.getSessionFile();
		const sessions = await SessionManager.list(sm.getCwd(), sm.getSessionDir());
		return sessions.map(s => ({
			path: s.path,
			id: s.id,
			title: s.title,
			firstMessage: s.firstMessage,
			messageCount: s.messageCount,
			modified: s.modified.getTime(),
			current: currentFile ? path.resolve(s.path) === path.resolve(currentFile) : false,
		}));
	}

	// ── State + agents projections ────────────────────────────────────────────

	#buildState(): CollabSessionState {
		const session = this.#session;
		const usage = session.getContextUsage();
		const goal = session.getGoalModeState?.();
		return {
			isStreaming: session.isStreaming,
			isAborting: session.isAborting,
			queuedMessageCount: session.queuedMessageCount,
			sessionName: session.sessionName,
			cwd: session.sessionManager.getCwd(),
			model: session.model,
			thinkingLevel: session.thinkingLevel,
			contextUsage: usage
				? { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent }
				: undefined,
			participants: this.#participants(),
			planMode: session.getPlanModeState?.()?.enabled === true,
			goalMode: goal ? { status: goal.goal.status, objective: goal.goal.objective } : null,
		};
	}

	#participants(): CollabParticipant[] {
		const list: CollabParticipant[] = [{ name: this.#hostName, role: "host" }];
		for (const peer of this.#peers) {
			list.push({ name: peer.name, role: "guest", readOnly: peer.canWrite ? undefined : true });
		}
		return list;
	}

	#snapshotAgents(): AgentSnapshot[] {
		return AgentRegistry.global()
			.list()
			.filter((ref): ref is AgentRef & { kind: "main" | "sub" } => ref.kind !== "advisor")
			.map(ref => ({
				id: ref.id,
				displayName: ref.displayName,
				kind: ref.kind,
				parentId: ref.parentId,
				status: ref.status,
				hasSessionFile: !!ref.sessionFile,
				createdAt: ref.createdAt,
				lastActivity: ref.lastActivity,
			}));
	}

	#onEventForState(event: AgentSessionEvent): void {
		if (!STATE_TRIGGER_EVENTS.has(event.type)) return;
		this.#scheduleStateBroadcast();
		if (event.type === "agent_start" && !this.#streamingInterval) {
			this.#streamingInterval = setInterval(() => this.#scheduleStateBroadcast(), STREAMING_STATE_INTERVAL_MS);
		} else if (event.type === "agent_end" && this.#streamingInterval) {
			clearInterval(this.#streamingInterval);
			this.#streamingInterval = null;
		}
	}

	#scheduleStateBroadcast(): void {
		if (this.#stopped || this.#stateDebounce) return;
		this.#stateDebounce = setTimeout(() => {
			this.#stateDebounce = null;
			const state = this.#buildState();
			const json = JSON.stringify(state);
			if (json === this.#lastStateJson) return;
			this.#lastStateJson = json;
			this.#broadcast({ t: "state", state });
		}, STATE_DEBOUNCE_MS);
	}

	#scheduleAgentsBroadcast(): void {
		if (this.#stopped || this.#agentsDebounce) return;
		this.#agentsDebounce = setTimeout(() => {
			this.#agentsDebounce = null;
			this.#broadcast({ t: "agents", agents: this.#snapshotAgents() });
		}, AGENTS_DEBOUNCE_MS);
	}

	// ── Guards ────────────────────────────────────────────────────────────────

	#guardWrite(peer: GatewayPeer): boolean {
		if (peer.canWrite) return true;
		peer.send({ t: "error", message: "this action is disabled on a read-only connection" });
		return false;
	}

	#requireWrite(peer: GatewayPeer): void {
		if (!peer.canWrite) throw new Error("this action is disabled on a read-only connection");
	}
}
