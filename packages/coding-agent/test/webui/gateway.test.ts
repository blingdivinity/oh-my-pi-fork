import { afterEach, describe, expect, it } from "bun:test";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionGateway } from "@oh-my-pi/pi-coding-agent/webui/gateway";
import { startWebServer } from "@oh-my-pi/pi-coding-agent/webui/server";
import type { GatewayOutbound, GatewayPeer } from "@oh-my-pi/pi-coding-agent/webui/types";
import { TempDir } from "@oh-my-pi/pi-utils";

const tempDirs: TempDir[] = [];

type SessionEventListener = (event: unknown) => void;

/** Minimal AgentSession stub covering only what the gateway touches in these flows. */
function makeStubSession(): { session: AgentSession; promptCalls: string[]; emit: SessionEventListener } {
	const dir = TempDir.createSync("@pi-webui-gw-");
	tempDirs.push(dir);
	const cwd = dir.path();
	const promptCalls: string[] = [];
	const listeners: SessionEventListener[] = [];
	const stub = {
		subscribe: (listener: SessionEventListener) => {
			listeners.push(listener);
			return () => {};
		},
		subscribeCommandMetadataChanged: () => () => {},
		getContextUsage: () => undefined,
		getAvailableModels: () => [],
		isStreaming: false,
		isAborting: false,
		queuedMessageCount: 0,
		sessionName: undefined,
		model: undefined,
		thinkingLevel: undefined,
		extensionRunner: undefined,
		customCommands: [],
		mcpPromptCommands: undefined,
		skills: [],
		skillsSettings: undefined,
		settings: { get: () => undefined },
		setSlashCommands: () => {},
		prompt: (text: string) => {
			promptCalls.push(text);
			return Promise.resolve(true);
		},
		sessionManager: {
			getCwd: () => cwd,
			snapshotForReplication: () => ({
				header: { type: "session", id: "s1", timestamp: new Date().toISOString(), cwd },
				entries: [],
			}),
			onEntryAppended: undefined as unknown,
		},
	};
	return {
		session: stub as unknown as AgentSession,
		promptCalls,
		emit: event => {
			for (const listener of listeners) listener(event);
		},
	};
}

class FakePeer implements GatewayPeer {
	readonly id = "peer-1";
	name = "";
	canWrite = true;
	readOnly = false;
	control = true;
	readonly frames: GatewayOutbound[] = [];
	#waiters: { match: (f: GatewayOutbound) => boolean; resolve: (f: GatewayOutbound) => void }[] = [];

	send(frame: GatewayOutbound): void {
		this.frames.push(frame);
		this.#waiters = this.#waiters.filter(w => {
			if (w.match(frame)) {
				w.resolve(frame);
				return false;
			}
			return true;
		});
	}

	close(): void {}

	/** Resolve when a frame matching `match` has been (or is later) sent. */
	waitFor(match: (f: GatewayOutbound) => boolean): Promise<GatewayOutbound> {
		const existing = this.frames.find(match);
		if (existing) return Promise.resolve(existing);
		const { promise, resolve } = Promise.withResolvers<GatewayOutbound>();
		this.#waiters.push({ match, resolve });
		return promise;
	}
}

const gateways: SessionGateway[] = [];

afterEach(async () => {
	for (const gw of gateways.splice(0)) gw.stop();
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

function makeGateway(): { gateway: SessionGateway; promptCalls: string[]; emit: SessionEventListener } {
	const { session, promptCalls, emit } = makeStubSession();
	const gateway = new SessionGateway({ session });
	gateways.push(gateway);
	gateway.start();
	return { gateway, promptCalls, emit };
}

describe("SessionGateway", () => {
	it("on hello sends welcome, a final snapshot chunk, and the control handshake", async () => {
		const { gateway } = makeGateway();
		const peer = new FakePeer();
		gateway.addPeer(peer);
		gateway.handleFrame(peer, { t: "hello", proto: 2, name: "tester" });

		const welcome = peer.frames.find(f => f.t === "welcome");
		expect(welcome).toBeDefined();
		const finalChunk = peer.frames.find(f => f.t === "snapshot-chunk" && f.final === true);
		expect(finalChunk).toBeDefined();
		const caps = peer.frames.find(f => f.t === "capabilities");
		expect(caps && "capabilities" in caps && caps.capabilities.control).toBe(true);
		// Commands are produced asynchronously after welcome.
		const commands = await peer.waitFor(f => f.t === "commands");
		expect(commands.t).toBe("commands");
		expect(peer.frames.some(f => f.t === "models")).toBe(true);
		expect(peer.frames.some(f => f.t === "mcp")).toBe(true);
		expect(peer.name).toBe("tester");
	});
	it("never broadcasts to a peer before its welcome+snapshot (connect-race)", () => {
		const { gateway, emit } = makeGateway();
		const peer = new FakePeer();
		// Peer connected but has NOT sent hello and is NOT registered.
		emit({ type: "message_start", message: { role: "assistant", content: [] } });
		expect(peer.frames).toHaveLength(0);

		gateway.handleFrame(peer, { t: "hello", proto: 2, name: "late" });
		expect(peer.frames[0]?.t).toBe("welcome");

		const beforeLive = peer.frames.length;
		emit({ type: "message_end", message: { role: "assistant", content: [] } });
		expect(peer.frames.length).toBeGreaterThan(beforeLive);
		expect(peer.frames.some(f => f.t === "event")).toBe(true);
	});

	it("routes a control prompt to session.prompt and acks it", async () => {
		const { gateway, promptCalls } = makeGateway();
		const peer = new FakePeer();
		gateway.addPeer(peer);
		gateway.handleFrame(peer, { t: "ctl", op: "prompt", reqId: 7, text: "hello world" });

		const ack = await peer.waitFor(f => f.t === "ctl-ack");
		expect(ack).toMatchObject({ t: "ctl-ack", reqId: 7, ok: true });
		expect(promptCalls).toContain("hello world");
	});

	it("rejects mutating frames from a read-only peer", () => {
		const { gateway, promptCalls } = makeGateway();
		const peer = new FakePeer();
		peer.canWrite = false;
		peer.readOnly = true;
		gateway.addPeer(peer);
		gateway.handleFrame(peer, { t: "prompt", text: "blocked" });
		expect(promptCalls).toHaveLength(0);
		expect(peer.frames.some(f => f.t === "error")).toBe(true);
	});
});

describe("startWebServer", () => {
	it("serves a websocket that completes the hello → welcome handshake", async () => {
		const { gateway } = makeGateway();
		const server = startWebServer(gateway, { token: "secret", port: 0, host: "127.0.0.1" });
		try {
			const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=secret`);
			const { promise: welcome, resolve } = Promise.withResolvers<GatewayOutbound>();
			ws.addEventListener("open", () => ws.send(JSON.stringify({ t: "hello", proto: 2, name: "ws-tester" })));
			ws.addEventListener("message", ev => {
				const frame = JSON.parse(String(ev.data)) as GatewayOutbound;
				if (frame.t === "welcome") resolve(frame);
			});
			const frame = await welcome;
			expect(frame.t).toBe("welcome");
			ws.close();
		} finally {
			server.stop();
		}
	});

	it("rejects a websocket upgrade with a bad token", async () => {
		const { gateway } = makeGateway();
		const server = startWebServer(gateway, { token: "secret", port: 0, host: "127.0.0.1" });
		try {
			const res = await fetch(`http://127.0.0.1:${server.port}/ws?token=wrong`, {
				headers: { Host: `127.0.0.1:${server.port}` },
			});
			expect(res.status).toBe(403);
		} finally {
			server.stop();
		}
	});
	it("rejects a non-loopback Host header (DNS-rebinding guard)", async () => {
		const { gateway } = makeGateway();
		const server = startWebServer(gateway, { token: "secret", port: 0, host: "127.0.0.1" });
		try {
			const res = await fetch(`http://127.0.0.1:${server.port}/healthz`, {
				headers: { Host: "evil.example.com" },
			});
			expect(res.status).toBe(403);
		} finally {
			server.stop();
		}
	});
});
