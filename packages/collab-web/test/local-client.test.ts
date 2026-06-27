import { describe, expect, it } from "bun:test";
import type { AssistantMessage, SessionHeader, SessionState } from "@oh-my-pi/pi-wire";
import { LocalClient } from "../src/lib/local-client";

const header: SessionHeader = { type: "session", id: "s1", timestamp: new Date().toISOString(), cwd: "/tmp" };
const state: SessionState = { isStreaming: false, queuedMessageCount: 0, cwd: "/tmp", participants: [] };
const assistant: AssistantMessage = {
	role: "assistant",
	content: [],
	model: "openai/gpt-5",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
	stopReason: "stop",
	timestamp: 0,
};

function newClient(): LocalClient {
	// Constructor does not open a socket until connect(), so no network here.
	return new LocalClient({ wsUrl: "ws://127.0.0.1:0/ws?token=x", name: "t" });
}

describe("LocalClient reducer", () => {
	it("goes live on an empty welcome and applies the control handshake", () => {
		const c = newClient();
		c.applyFrameForTest({ t: "welcome", proto: 2, header, state, agents: [], entryCount: 0 });
		expect(c.getSnapshot().phase).toBe("live");

		c.applyFrameForTest({
			t: "capabilities",
			capabilities: { canWrite: true, control: true, features: ["slash"], proto: 1 },
		});
		expect(c.getSnapshot().capabilities?.control).toBe(true);
		expect(c.getSnapshot().readOnly).toBe(false);

		c.applyFrameForTest({
			t: "models",
			models: [{ id: "openai/gpt-5", modelId: "gpt-5", name: "GPT-5", provider: "openai", current: true }],
		});
		expect(c.getSnapshot().models[0]?.modelId).toBe("gpt-5");
		expect(c.getSnapshot().models[0]?.current).toBe(true);

		c.applyFrameForTest({ t: "mcp", servers: [{ name: "fs", status: "connected", toolCount: 3 }] });
		expect(c.getSnapshot().mcp[0]?.status).toBe("connected");
	});

	it("queues extension-UI dialogs and tool approvals; handles fire-and-forget notify", () => {
		const c = newClient();
		c.applyFrameForTest({
			t: "ext-ui-request",
			request: { id: "d1", method: "confirm", title: "ok?", message: "sure?" },
		});
		expect(c.getSnapshot().pendingExtUI?.id).toBe("d1");

		c.applyFrameForTest({
			t: "ext-ui-request",
			request: { id: "n1", method: "notify", message: "hi", notifyType: "info" },
		});
		// notify is fire-and-forget: a notice, not a queued dialog.
		expect(c.getSnapshot().pendingExtUI?.id).toBe("d1");
		expect(c.getSnapshot().notices.some(n => n.message === "hi")).toBe(true);

		c.applyFrameForTest({
			t: "tool-approval-request",
			request: { id: "a1", toolName: "bash", args: { command: "ls" } },
		});
		expect(c.getSnapshot().pendingApproval?.toolName).toBe("bash");
		c.applyFrameForTest({ t: "tool-approval-cancel", approvalId: "a1" });
		expect(c.getSnapshot().pendingApproval).toBeNull();
	});

	it("tracks the streaming assistant ghost across message events", () => {
		const c = newClient();
		c.applyFrameForTest({ t: "welcome", proto: 2, header, state, agents: [], entryCount: 0 });
		c.applyFrameForTest({ t: "event", event: { type: "message_start", message: assistant } });
		expect(c.getSnapshot().stream).not.toBeNull();
		expect(c.getSnapshot().streamDone).toBe(false);
		c.applyFrameForTest({ t: "event", event: { type: "message_end", message: assistant } });
		expect(c.getSnapshot().streamDone).toBe(true);
	});
});
