import { describe, expect, it } from "bun:test";
import * as http2 from "node:http2";
import { create, toBinary } from "@bufbuild/protobuf";
import {
	buildCursorHistoryForTest,
	buildCursorSystemPromptJsons,
	resolveExecHandler,
	streamCursor,
} from "@oh-my-pi/pi-ai/providers/cursor";
import type { Context, CursorExecHandlers, Model, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	type AgentRunRequest,
	type AgentServerMessage,
	AgentServerMessageSchema,
	ExecServerMessageSchema,
	GrepArgsSchema,
	InteractionUpdateSchema,
	ReadArgsSchema,
	TextDeltaUpdateSchema,
	TurnEndedUpdateSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-gen/agent_pb";

const cursorModel: Model<"cursor-agent"> = buildModel({
	id: "cursor-composer-2.5",
	name: "Cursor Composer 2.5",
	api: "cursor-agent",
	provider: "cursor",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1,
	maxTokens: 1,
});

function frameServerMessage(message: AgentServerMessage): Buffer {
	const bytes = toBinary(AgentServerMessageSchema, message);
	const frame = Buffer.alloc(5 + bytes.length);
	frame[0] = 0;
	frame.writeUInt32BE(bytes.length, 1);
	Buffer.from(bytes).copy(frame, 5);
	return frame;
}

function cursorTextDelta(text: string): AgentServerMessage {
	return create(AgentServerMessageSchema, {
		message: {
			case: "interactionUpdate",
			value: create(InteractionUpdateSchema, {
				message: { case: "textDelta", value: create(TextDeltaUpdateSchema, { text }) },
			}),
		},
	});
}

function cursorTurnEnded(): AgentServerMessage {
	return create(AgentServerMessageSchema, {
		message: {
			case: "interactionUpdate",
			value: create(InteractionUpdateSchema, {
				message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) },
			}),
		},
	});
}

function cursorReadExec(id: number, toolCallId: string): AgentServerMessage {
	return create(AgentServerMessageSchema, {
		message: {
			case: "execServerMessage",
			value: create(ExecServerMessageSchema, {
				id,
				message: { case: "readArgs", value: create(ReadArgsSchema, { path: "a.ts", toolCallId }) },
			}),
		},
	});
}

function cursorGrepExec(id: number, toolCallId: string): AgentServerMessage {
	return create(AgentServerMessageSchema, {
		message: {
			case: "execServerMessage",
			value: create(ExecServerMessageSchema, {
				id,
				message: { case: "grepArgs", value: create(GrepArgsSchema, { pattern: "needle", toolCallId }) },
			}),
		},
	});
}

function makeCursorToolResult(toolCallId: string, toolName: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

function captureCursorPayload(context: Context): Promise<AgentRunRequest> {
	const { promise, resolve, reject } = Promise.withResolvers<AgentRunRequest>();
	streamCursor(cursorModel, context, {
		apiKey: "test-token",
		onPayload: payload => {
			if (isAgentRunRequest(payload)) {
				resolve(payload);
			} else {
				reject(new Error("Cursor payload was not an AgentRunRequest"));
			}
			throw new Error("stop after capturing Cursor payload");
		},
	});
	return promise;
}

function isAgentRunRequest(payload: unknown): payload is AgentRunRequest {
	return !!payload && typeof payload === "object" && "$typeName" in payload;
}

function toolResultContext(): Context {
	return {
		messages: [
			{ role: "user", content: "Use the read tool.", timestamp: 1 },
			{
				role: "assistant",
				api: "cursor-agent",
				provider: "cursor",
				model: "cursor-composer-2.5",
				content: [
					{
						type: "toolCall",
						id: "call-read",
						name: "read",
						arguments: { path: "package.json" },
					},
				],
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "call-read",
				toolName: "read",
				content: [{ type: "text", text: "package contents" }],
				isError: false,
				timestamp: 3,
			},
		],
	};
}

describe("Cursor stream message ordering", () => {
	it("serializes async exec frames between surrounding text deltas", async () => {
		const server = http2.createServer();
		const messages = [
			cursorTextDelta("before A "),
			cursorReadExec(1, "a"),
			cursorTextDelta("between A and B "),
			cursorGrepExec(2, "b"),
			cursorTextDelta("after B"),
			cursorTurnEnded(),
		];
		server.on("stream", stream => {
			const responseStream = stream as http2.ServerHttp2Stream;
			responseStream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			for (const message of messages) {
				responseStream.write(frameServerMessage(message));
			}
			responseStream.end();
		});

		const listening = Promise.withResolvers<void>();
		server.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const address = server.address();
		if (!address || typeof address === "string") {
			throw new Error("Expected test server address");
		}

		const sequence: string[] = [];
		const execHandlers: CursorExecHandlers = {
			async read(args) {
				await Bun.sleep(20);
				return makeCursorToolResult(args.toolCallId, "read", "A result");
			},
			async grep(args) {
				return makeCursorToolResult(args.toolCallId, "grep", "B result");
			},
		};

		try {
			const stream = streamCursor(
				{ ...cursorModel, baseUrl: `http://127.0.0.1:${address.port}` },
				{ messages: [{ role: "user", content: "go", timestamp: 0 }] },
				{
					apiKey: "test-token",
					execHandlers,
					onToolResult: message => {
						sequence.push(`tool:${message.toolCallId}`);
						return message;
					},
				},
			);

			for await (const event of stream) {
				if (event.type === "text_delta") {
					sequence.push(`text:${event.delta}`);
				}
			}
		} finally {
			const closed = Promise.withResolvers<void>();
			server.close(() => closed.resolve());
			await closed.promise;
		}

		expect(sequence).toEqual(["text:before A ", "tool:a", "text:between A and B ", "tool:b", "text:after B"]);
	});
});

describe("Cursor resolveExecHandler execHandlers binding", () => {
	it("invokes handler with correct this when passed as bound method", async () => {
		const sentinel = { tag: "bound-correctly" };
		const handlers = {
			sentinel,
			async read(_args: { path: string }) {
				// Handler methods rely on 'this' (e.g. to access other handlers or state).
				// When passed without .bind(handlers), 'this' is undefined in strict mode.
				return { execResult: (this as typeof handlers).sentinel, toolResult: undefined };
			},
		};

		const { execResult } = await resolveExecHandler(
			{ path: "/tmp/foo" },
			handlers.read.bind(handlers),
			undefined,
			() => ({}),
			() => ({ tag: "rejected" }),
			() => ({ tag: "error" }),
		);

		expect(execResult).toBe(sentinel);
		expect((execResult as { tag: string }).tag).toBe("bound-correctly");
	});

	it("handler loses this when passed unbound and fails or returns wrong result", async () => {
		const sentinel = { tag: "bound-correctly" };
		const handlers = {
			sentinel,
			async read(_args: { path: string }) {
				return { execResult: (this as typeof handlers).sentinel, toolResult: undefined };
			},
		};

		// Pass method reference without .bind(handlers). In strict mode 'this' is undefined
		// when resolveExecHandler calls handler(args), so (this as any).sentinel throws.
		const { execResult } = await resolveExecHandler(
			{ path: "/tmp/foo" },
			handlers.read,
			undefined,
			() => ({}),
			() => ({ tag: "rejected" }),
			(msg: string) => ({ tag: "error", message: msg }),
		);

		// Should get error result (handler threw accessing undefined.sentinel)
		expect(execResult).toEqual({ tag: "error", message: expect.any(String) });
	});
});

describe("Cursor system prompt encoding", () => {
	it("emits one Cursor system blob per ordered prompt", () => {
		const jsons = buildCursorSystemPromptJsons(["Primary instructions.", "Developer constraints."]);
		expect(jsons).toHaveLength(2);
		expect(JSON.parse(jsons[0])).toEqual({ role: "system", content: "Primary instructions." });
		expect(JSON.parse(jsons[1])).toEqual({ role: "system", content: "Developer constraints." });
	});

	it("falls back to a single default system message when all entries are empty", () => {
		const jsons = buildCursorSystemPromptJsons(["", ""]);
		expect(jsons).toHaveLength(1);
		expect(JSON.parse(jsons[0])).toEqual({ role: "system", content: "You are a helpful assistant." });
	});
});

describe("Cursor request action encoding", () => {
	it("uses a resume action for empty user turns", async () => {
		const payload = await captureCursorPayload({
			messages: [{ role: "user", content: "   ", timestamp: 0 }],
		});

		expect(payload.action?.action.case).toBe("resumeAction");
	});

	it("uses a user message action for non-empty user turns", async () => {
		const payload = await captureCursorPayload({
			messages: [{ role: "user", content: "continue", timestamp: 0 }],
		});

		expect(payload.action?.action.case).toBe("userMessageAction");
	});

	it("uses a resume action when a tool result is the final context message", async () => {
		const payload = await captureCursorPayload(toolResultContext());

		expect(payload.action?.action.case).toBe("resumeAction");
	});

	it("uses a user message action with selected context for image-only user turns", async () => {
		const imageData = "aW1hZ2U=";
		const payload = await captureCursorPayload({
			messages: [
				{
					role: "user",
					content: [{ type: "image", data: imageData, mimeType: "image/png" }],
					timestamp: 0,
				},
			],
		});

		if (payload.action?.action.case !== "userMessageAction") {
			throw new Error("Expected Cursor userMessageAction");
		}
		const userMessage = payload.action.action.value.userMessage;
		expect(userMessage?.text).toBe("");
		expect(userMessage?.selectedContext?.selectedImages).toHaveLength(1);
		const selectedImage = userMessage?.selectedContext?.selectedImages[0];
		expect(selectedImage?.mimeType).toBe("image/png");
		if (selectedImage?.dataOrBlobId.case !== "data") {
			throw new Error("Expected Cursor selected image data");
		}
		expect(Array.from(selectedImage.dataOrBlobId.value)).toEqual(Array.from(Buffer.from(imageData, "base64")));
	});
});

describe("Cursor history encoding", () => {
	it("preserves image-only user turns in root prompt history and conversation turns", () => {
		const imageData = "aW1hZ2U=";
		const history = buildCursorHistoryForTest([
			{
				role: "user",
				content: [{ type: "image", data: imageData, mimeType: "image/png" }],
				timestamp: 0,
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "I can see it." }],
				api: "cursor-agent",
				provider: "cursor",
				model: "cursor-composer-2.5",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 0,
			},
			{ role: "user", content: "what is in the image?", timestamp: 0 },
		]);

		expect(history.rootPromptMessagesJson).toEqual([
			{
				role: "user",
				content: [{ type: "image", image: imageData, mediaType: "image/png" }],
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "I can see it." }],
			},
		]);
		expect(history.turnUserMessagesJson).toEqual([
			expect.objectContaining({
				selectedContext: {
					selectedImages: [
						expect.objectContaining({
							mimeType: "image/png",
							data: imageData,
						}),
					],
				},
			}),
		]);
	});

	it("preserves trailing tool result history for resume actions", () => {
		const history = buildCursorHistoryForTest(toolResultContext().messages, -1);

		expect(history.rootPromptMessagesJson).toEqual([
			{
				role: "user",
				content: [{ type: "text", text: "Use the read tool." }],
			},
			{
				role: "user",
				content: [{ type: "text", text: "[Tool Result]\npackage contents" }],
			},
		]);
		expect(history.turnUserMessagesJson).toEqual([expect.objectContaining({ text: "Use the read tool." })]);
		expect(history.turnStepMessagesJson).toEqual([
			[expect.objectContaining({ assistantMessage: { text: "[Tool Result]\npackage contents" } })],
		]);
	});

	it("formats tool errors with [Tool Error] prefix", () => {
		const errorContext: Context = {
			messages: [
				{
					role: "user",
					content: "Search for nothing.",
					timestamp: 1,
				},
				{
					role: "assistant",
					api: "cursor-agent",
					provider: "cursor",
					model: "cursor-composer-2.5",
					content: [
						{
							type: "toolCall",
							id: "call-search",
							name: "search",
							arguments: { pattern: "" },
						},
					],
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "call-search",
					toolName: "search",
					content: [{ type: "text", text: "Pattern must not be empty" }],
					isError: true,
					timestamp: 3,
				},
			],
		};

		const history = buildCursorHistoryForTest(errorContext.messages, -1);

		expect(history.rootPromptMessagesJson).toEqual([
			{
				role: "user",
				content: [{ type: "text", text: "Search for nothing." }],
			},
			{
				role: "user",
				content: [{ type: "text", text: "[Tool Error]\nPattern must not be empty" }],
			},
		]);
		expect(history.turnStepMessagesJson).toEqual([
			[expect.objectContaining({ assistantMessage: { text: "[Tool Error]\nPattern must not be empty" } })],
		]);
	});
});
