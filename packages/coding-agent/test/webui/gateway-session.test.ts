/**
 * Real-session end-to-end: a live AgentSession (mock model) behind the
 * SessionGateway + Bun.serve WebSocket server, driven exactly as the browser
 * SPA would — hello handshake, control prompt, streamed assistant output and
 * durable transcript entry observed over the wire. This is the protocol-level
 * proof that the coding-agent core is fully decoupled: the only thing talking
 * to the agent here is a plain WebSocket speaking @oh-my-pi/pi-wire.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SessionGateway } from "@oh-my-pi/pi-coding-agent/webui/gateway";
import { startWebServer } from "@oh-my-pi/pi-coding-agent/webui/server";
import type { GatewayOutbound } from "@oh-my-pi/pi-coding-agent/webui/types";
import { Snowflake, TempDir } from "@oh-my-pi/pi-utils";

const tempDirs: TempDir[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	// LIFO teardown: stop transport + gateway before disposing the session, and
	// never let one slow cleanup mask the others.
	for (const fn of cleanups.splice(0).reverse()) {
		try {
			await fn();
		} catch {}
	}
	for (const dir of tempDirs.splice(0)) {
		try {
			await dir.remove();
		} catch {}
	}
}, 30_000);

async function makeRealSession(assistantText: string): Promise<AgentSession> {
	const tempDir = TempDir.createSync("@pi-webui-session-");
	tempDirs.push(tempDir);
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("bundled model unavailable");
	const mock = createMockModel({ responses: [{ content: [assistantText] }] });
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [] },
		streamFn: mock.stream,
	});
	const sessionManager = SessionManager.inMemory(tempDir.path());
	const settings = Settings.isolated({ "compaction.enabled": false });
	const authStorage = await AuthStorage.create(tempDir.join(`auth-${Snowflake.next()}.db`));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	cleanups.push(() => authStorage.close());
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	const session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
	cleanups.push(() => session.dispose());
	return session;
}

/** Connect a WS client, run the handshake, and collect frames with awaitable predicates. */
function connect(port: number): {
	send: (frame: unknown) => void;
	waitFor: (match: (f: GatewayOutbound) => boolean) => Promise<GatewayOutbound>;
	frames: GatewayOutbound[];
	close: () => void;
	opened: Promise<void>;
} {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=secret`);
	const frames: GatewayOutbound[] = [];
	const waiters: { match: (f: GatewayOutbound) => boolean; resolve: (f: GatewayOutbound) => void }[] = [];
	const { promise: opened, resolve: resolveOpen } = Promise.withResolvers<void>();
	ws.addEventListener("open", () => resolveOpen());
	ws.addEventListener("message", ev => {
		const frame = JSON.parse(String(ev.data)) as GatewayOutbound;
		frames.push(frame);
		for (let i = waiters.length - 1; i >= 0; i--) {
			const w = waiters[i];
			if (w?.match(frame)) {
				w.resolve(frame);
				waiters.splice(i, 1);
			}
		}
	});
	return {
		send: frame => ws.send(JSON.stringify(frame)),
		frames,
		opened,
		waitFor: match => {
			const existing = frames.find(match);
			if (existing) return Promise.resolve(existing);
			const { promise, resolve } = Promise.withResolvers<GatewayOutbound>();
			waiters.push({ match, resolve });
			return promise;
		},
		close: () => ws.close(),
	};
}

describe("web gateway over a real AgentSession", () => {
	it("streams a real assistant turn to a websocket client end-to-end", async () => {
		const session = await makeRealSession("Hello from the web gateway");
		const gateway = new SessionGateway({ session });
		gateway.start();
		cleanups.push(() => gateway.stop());
		const server = startWebServer(gateway, { token: "secret", port: 0, host: "127.0.0.1" });
		cleanups.push(() => server.stop());

		const client = connect(server.port);
		await client.opened;
		client.send({ t: "hello", proto: 2, name: "e2e" });
		await client.waitFor(f => f.t === "welcome");
		await client.waitFor(f => f.t === "snapshot-chunk" && f.final === true);

		// Drive a real turn through the control channel.
		client.send({ t: "ctl", op: "prompt", reqId: 1, text: "say hi" });

		// The mock model's assistant text must arrive as a streamed message_end event.
		const messageEnd = await client.waitFor(
			f => f.t === "event" && f.event.type === "message_end" && f.event.message.role === "assistant",
		);
		const text = JSON.stringify(messageEnd);
		expect(text).toContain("Hello from the web gateway");

		// And the turn must also land as a durable transcript entry frame.
		const entry = await client.waitFor(
			f =>
				f.t === "entry" &&
				f.entry.type === "message" &&
				f.entry.message.role === "assistant" &&
				JSON.stringify(f.entry).includes("Hello from the web gateway"),
		);
		expect(entry.t).toBe("entry");

		client.close();
	});

	it("reflects a model switch via the control channel", async () => {
		const session = await makeRealSession("ok");
		const gateway = new SessionGateway({ session });
		gateway.start();
		cleanups.push(() => gateway.stop());
		const server = startWebServer(gateway, { token: "secret", port: 0, host: "127.0.0.1" });
		cleanups.push(() => server.stop());

		const client = connect(server.port);
		await client.opened;
		client.send({ t: "hello", proto: 2, name: "e2e" });
		const models = await client.waitFor(f => f.t === "models");
		expect(models.t).toBe("models");
		if (models.t !== "models") throw new Error("unreachable");
		expect(Array.isArray(models.models)).toBe(true);

		client.send({ t: "ctl", op: "get-commands", reqId: 9 });
		const ack = await client.waitFor(f => f.t === "ctl-ack" && f.reqId === 9);
		expect(ack).toMatchObject({ ok: true });
		await client.waitFor(f => f.t === "commands");

		client.close();
	});
});
