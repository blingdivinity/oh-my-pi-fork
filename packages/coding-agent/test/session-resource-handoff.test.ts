import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry, type ProviderConfigInput } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadedCustomCommand } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import {
	EXTENSION_HANDLER_TIMEOUT_MS,
	testSetExtensionHandlerTimeoutMs,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp";
import type { MemoryBackend } from "@oh-my-pi/pi-coding-agent/memory-backend";
import * as memoryBackendModule from "@oh-my-pi/pi-coding-agent/memory-backend";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { createAgentSession, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";
import { type } from "arktype";

interface SessionHarness {
	readonly tempDir: TempDir;
	readonly authStorage: AuthStorage;
	readonly modelRegistry: ModelRegistry;
	readonly session: AgentSession;
	readonly setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
}

interface HarnessOptions {
	readonly additionalExtensionPaths?: readonly string[];
	readonly enableMCP?: boolean;
	readonly useDefaultSystemPrompt?: boolean;
	readonly settings?: Settings;
	readonly toolNames?: readonly string[];
}

const harnesses: SessionHarness[] = [];

async function createHarness(
	extensions: ExtensionFactory[] = [],
	options: HarnessOptions = {},
): Promise<SessionHarness> {
	const tempDir = TempDir.createSync("@pi-resource-handoff-");
	const cwd = tempDir.path();
	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	authStorage.setRuntimeApiKey("openai", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.json"));
	const model = getBundledModel("openai", "gpt-4o-mini");
	if (!model) throw new Error("Expected bundled OpenAI test model");
	const enableMCP = options.enableMCP ?? false;
	const { session, setToolUIContext } = await createAgentSession({
		cwd,
		agentDir: cwd,
		sessionManager: SessionManager.inMemory(cwd),
		authStorage,
		modelRegistry,
		settings: options.settings ?? Settings.isolated({ "async.enabled": false }),
		model,
		...(options.useDefaultSystemPrompt ? {} : { systemPrompt: [] }),
		disableExtensionDiscovery: true,
		extensions,
		...(options.toolNames ? { toolNames: [...options.toolNames] } : {}),
		...(options.additionalExtensionPaths ? { additionalExtensionPaths: [...options.additionalExtensionPaths] } : {}),
		skills: [],
		rules: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		workspaceTree: {
			rootPath: cwd,
			rendered: "",
			truncated: false,
			totalLines: 0,
			agentsMdFiles: [],
		},
		...(enableMCP ? { hasUI: true } : {}),
		enableMCP,
		enableLsp: false,
		skipPythonPreflight: true,
	});
	if (enableMCP) await session.reloadMCPResources();
	const harness = { tempDir, authStorage, modelRegistry, session, setToolUIContext };
	harnesses.push(harness);
	return harness;
}

afterEach(async () => {
	for (const harness of harnesses.splice(0).reverse()) {
		try {
			await harness.session.dispose();
		} finally {
			harness.authStorage.close();
			await harness.tempDir.remove();
		}
	}
});

describe("session resource handoff adapters", () => {
	it("restores the applied extension provider generation after a failed handoff", async () => {
		let providerVersion: "v1" | "invalid" | "v2" = "v1";
		const providerExtension: ExtensionFactory = pi => {
			const modelId = providerVersion === "invalid" ? "broken-model" : `runtime-model-${providerVersion}`;
			const config: ProviderConfigInput = {
				api: "openai-completions",
				apiKey: "runtime-key",
				...(providerVersion === "invalid" ? {} : { baseUrl: `https://${providerVersion}.example.test/v1` }),
				models: [
					{
						id: modelId,
						name: modelId,
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 16_384,
						maxTokens: 4_096,
					},
				],
			};
			pi.registerProvider("reload-provider", config);
		};
		const { modelRegistry, session } = await createHarness([providerExtension]);
		const beforeStatus = session.resourceStatus;
		if (!beforeStatus) throw new Error("Expected session resource status");

		expect(modelRegistry.find("reload-provider", "runtime-model-v1")?.baseUrl).toBe("https://v1.example.test/v1");

		providerVersion = "invalid";
		const failed = await session.reloadResources(["providers"]);
		expect(failed?.state).toBe("failed");
		expect(modelRegistry.find("reload-provider", "runtime-model-v1")?.baseUrl).toBe("https://v1.example.test/v1");
		expect(modelRegistry.find("reload-provider", "broken-model")).toBeUndefined();
		const failedStatus = session.resourceStatus;
		expect(failedStatus).toMatchObject({
			appliedRevision: beforeStatus.appliedRevision,
			manifestId: beforeStatus.manifestId,
			lastReloadState: "failed",
			degraded: false,
		});
		expect(failedStatus?.desiredRevision).toBeGreaterThan(beforeStatus.desiredRevision);
		expect(failedStatus?.domains.find(domain => domain.domain === "providers")).toMatchObject({
			desiredRevision: failedStatus?.desiredRevision,
			state: "failed",
			lastError: expect.stringContaining("baseUrl"),
		});

		providerVersion = "v2";
		const applied = await session.reloadResources(["providers"]);
		expect(applied?.state).toBe("applied");
		expect(modelRegistry.find("reload-provider", "runtime-model-v1")).toBeUndefined();
		expect(modelRegistry.find("reload-provider", "runtime-model-v2")?.baseUrl).toBe("https://v2.example.test/v1");
		const appliedStatus = session.resourceStatus;
		expect(appliedStatus).toMatchObject({
			desiredRevision: appliedStatus?.appliedRevision,
			lastReloadState: "applied",
			degraded: false,
		});
		expect(appliedStatus?.domains.find(domain => domain.domain === "providers")?.state).toBe("current");
	});

	it("does not expose rejected candidate tool names to applied tool executions", async () => {
		let rejectCandidate = false;
		const extension: ExtensionFactory = pi => {
			const modelId = rejectCandidate ? "rejected-model" : "applied-model";
			pi.registerProvider("candidate-provider", {
				api: "openai-completions",
				apiKey: "runtime-key",
				...(rejectCandidate ? {} : { baseUrl: "https://applied.example.test/v1" }),
				models: [
					{
						id: modelId,
						name: modelId,
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 16_384,
						maxTokens: 4_096,
					},
				],
			});
			if (rejectCandidate) return;
			pi.registerTool({
				name: "applied_generation_tool",
				label: "Applied Generation Tool",
				description: "Tool owned by the applied extension generation.",
				parameters: pi.typebox.Type.Object({}),
				async execute() {
					return { content: [{ type: "text", text: "applied" }] };
				},
			});
		};
		const settings = Settings.isolated({
			"async.enabled": false,
			"bashInterceptor.enabled": true,
			"bashInterceptor.patterns": [
				{
					pattern: "^printf candidate-context$",
					tool: "applied_generation_tool",
					message: "use applied generation tool",
				},
			],
		});
		const { session } = await createHarness([extension], {
			settings,
			toolNames: ["bash", "applied_generation_tool"],
		});
		expect(session.getEnabledToolNames()).toContain("applied_generation_tool");

		rejectCandidate = true;
		const result = await session.reloadResources(["providers"]);

		expect(result?.state).toBe("failed");
		expect(session.getEnabledToolNames()).toContain("applied_generation_tool");
		const mock = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							id: "candidate-context-call",
							name: "bash",
							arguments: { command: "printf candidate-context" },
						},
					],
				},
				{ content: ["done"] },
			],
		});
		session.agent.streamFn = mock.stream;
		await session.prompt("Verify the applied execution context.");
		const bashResult = session.messages.find(message => message.role === "toolResult" && message.toolName === "bash");
		expect(bashResult).toBeDefined();
		expect(JSON.stringify(bashResult)).toContain("Blocked: use applied generation tool");
	});

	it("refreshes the active model when same-id provider configuration changes", async () => {
		let baseUrl = "https://v1.example.test/v1";
		const providerExtension: ExtensionFactory = pi => {
			const config: ProviderConfigInput = {
				api: "openai-completions",
				apiKey: "runtime-key",
				baseUrl,
				models: [
					{
						id: "runtime-model",
						name: "runtime-model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 16_384,
						maxTokens: 4_096,
					},
				],
			};
			pi.registerProvider("reload-provider", config);
		};
		const { modelRegistry, session } = await createHarness([providerExtension]);
		const initialModel = modelRegistry.find("reload-provider", "runtime-model");
		if (!initialModel) throw new Error("Expected extension provider model");
		await session.setModel(initialModel);
		expect(session.model?.baseUrl).toBe("https://v1.example.test/v1");

		baseUrl = "https://v2.example.test/v1";
		const applied = await session.reloadResources(["providers"]);

		expect(applied?.state).toBe("applied");
		expect(modelRegistry.find("reload-provider", "runtime-model")?.baseUrl).toBe(baseUrl);
		expect(session.model?.baseUrl).toBe(baseUrl);
	});

	it("retires an owned MCP manager only after replacing it with a borrowed manager", async () => {
		const { session } = await createHarness([], { enableMCP: true });
		const owned = session.mcpManager;
		if (!owned) throw new Error("Expected owned MCP manager");
		const borrowed = new MCPManager(session.sessionManager.getCwd());
		const nextBorrowed = new MCPManager(session.sessionManager.getCwd());
		const disconnectOwned = spyOn(owned, "disconnectAll");

		expect(session.mcpManager).toBe(owned);
		expect(disconnectOwned).not.toHaveBeenCalled();

		await session.replaceMCPManager(borrowed);
		expect(session.mcpManager).toBe(borrowed);
		expect(disconnectOwned).toHaveBeenCalledTimes(1);

		await session.replaceMCPManager(nextBorrowed);
		expect(session.mcpManager).toBe(nextBorrowed);
		expect(disconnectOwned).toHaveBeenCalledTimes(1);
	});

	it("keeps an MCP prompt generation admitted until command execution finishes", async () => {
		const { session } = await createHarness([], { enableMCP: true });
		const owned = session.mcpManager;
		if (!owned) throw new Error("Expected owned MCP manager");
		const borrowed = new MCPManager(session.sessionManager.getCwd());
		const commandStarted = Promise.withResolvers<void>();
		const releaseCommand = Promise.withResolvers<void>();
		session.setMCPPromptCommands([
			{
				path: "mcp:server:prompt",
				resolvedPath: "mcp:server:prompt",
				source: "bundled",
				command: {
					name: "server:prompt",
					description: "Gated MCP prompt.",
					async execute() {
						commandStarted.resolve();
						await releaseCommand.promise;
					},
				},
			},
		]);
		const disconnectOwned = spyOn(owned, "disconnectAll");
		const execution = session.prompt("/server:prompt");
		await commandStarted.promise;
		let replacementSettled = false;
		const replacement = session.replaceMCPManager(borrowed);
		void replacement.then(
			() => {
				replacementSettled = true;
			},
			() => {
				replacementSettled = true;
			},
		);
		try {
			await Bun.sleep(0);
			expect(replacementSettled).toBe(false);
			expect(disconnectOwned).not.toHaveBeenCalled();

			releaseCommand.resolve();
			await Promise.all([execution, replacement]);
			expect(disconnectOwned).toHaveBeenCalledTimes(1);
			expect(session.mcpPromptCommands).toEqual([]);
		} finally {
			releaseCommand.resolve();
		}
	});

	it("serializes owned MCP rediscovery behind prompt command execution", async () => {
		const { session } = await createHarness([], { enableMCP: true });
		const manager = session.mcpManager;
		if (!manager) throw new Error("Expected owned MCP manager");
		const commandStarted = Promise.withResolvers<void>();
		const releaseCommand = Promise.withResolvers<void>();
		session.setMCPPromptCommands([
			{
				path: "mcp:server:prompt",
				resolvedPath: "mcp:server:prompt",
				source: "bundled",
				command: {
					name: "server:prompt",
					description: "Gated MCP prompt.",
					async execute() {
						commandStarted.resolve();
						await releaseCommand.promise;
					},
				},
			},
		]);
		const rediscover = spyOn(manager, "rediscoverAndConnect").mockResolvedValue({
			tools: [],
			errors: new Map(),
			connectedServers: [],
			exaApiKeys: [],
		});
		const execution = session.prompt("/server:prompt");
		await commandStarted.promise;
		const reload = session.reloadMCPResources();
		try {
			await Bun.sleep(0);
			expect(rediscover).not.toHaveBeenCalled();

			releaseCommand.resolve();
			await Promise.all([execution, reload]);
			expect(rediscover).toHaveBeenCalledTimes(1);
		} finally {
			releaseCommand.resolve();
		}
	});

	it("rejects a signal-less queued MCP reload when session disposal begins", async () => {
		const { session } = await createHarness([], { enableMCP: true });
		const manager = session.mcpManager;
		if (!manager) throw new Error("Expected owned MCP manager");
		const commandStarted = Promise.withResolvers<void>();
		const releaseCommand = Promise.withResolvers<void>();
		session.setMCPPromptCommands([
			{
				path: "mcp:server:prompt",
				resolvedPath: "mcp:server:prompt",
				source: "bundled",
				command: {
					name: "server:prompt",
					description: "Gated MCP prompt.",
					async execute() {
						commandStarted.resolve();
						await releaseCommand.promise;
					},
				},
			},
		]);
		const rediscover = spyOn(manager, "rediscoverAndConnect").mockResolvedValue({
			tools: [],
			errors: new Map(),
			connectedServers: [],
			exaApiKeys: [],
		});
		const execution = session.prompt("/server:prompt");
		await commandStarted.promise;
		const reload = session.reloadMCPResources();
		let disposal: Promise<void> | undefined;
		try {
			await Bun.sleep(0);
			expect(rediscover).not.toHaveBeenCalled();

			disposal = session.dispose();
			const outcome = await withTimeout(
				reload.then(
					() => undefined,
					error => error,
				),
				500,
				"Queued signal-less MCP reload did not reject after disposal",
			);
			if (!(outcome instanceof Error)) throw new Error(`Expected disposal cancellation, got ${String(outcome)}`);
			expect(outcome.message).toBe("Agent session was disposed during MCP reload");
			expect(rediscover).not.toHaveBeenCalled();
		} finally {
			releaseCommand.resolve();
			await Promise.allSettled([execution, disposal ?? Promise.resolve()]);
		}
	});

	it("reconnects an owned MCP generation through the canonical plugin reload and reports partial failures", async () => {
		const { session } = await createHarness([], { enableMCP: true });
		const manager = session.mcpManager;
		if (!manager) throw new Error("Expected owned MCP manager");
		const rediscover = spyOn(manager, "rediscoverAndConnect").mockResolvedValue({
			tools: [],
			errors: new Map([["broken-server", "connection refused"]]),
			connectedServers: [],
			exaApiKeys: [],
		});

		const result = await session.reloadPluginResources();

		expect(rediscover).toHaveBeenCalledWith(
			session.sessionManager.getCwd(),
			expect.objectContaining({
				enableProjectConfig: true,
				filterExa: true,
				filterBrowser: true,
				signal: expect.any(AbortSignal),
			}),
		);
		expect(result?.state).toBe("degraded");
		expect(result?.diagnostics).toContainEqual({
			severity: "warning",
			domain: "mcp",
			message: "broken-server: connection refused",
		});
		expect(session.resourceStatus).toMatchObject({
			desiredRevision: session.resourceStatus?.appliedRevision,
			lastReloadState: "degraded",
			degraded: true,
		});
		expect(session.resourceStatus?.domains.find(domain => domain.domain === "mcp")).toMatchObject({
			state: "degraded",
			lastError: "broken-server: connection refused",
		});
	});

	it("removes stale MCP prompt commands when rediscovery has no prompts", async () => {
		const { session } = await createHarness([], { enableMCP: true });
		const manager = session.mcpManager;
		if (!manager) throw new Error("Expected owned MCP manager");
		const staleCommand: LoadedCustomCommand = {
			path: "mcp:retired:prompt",
			resolvedPath: "mcp:retired:prompt",
			source: "bundled",
			command: {
				name: "retired:prompt",
				description: "Prompt from a retired MCP server.",
				async execute() {
					return "stale";
				},
			},
		};
		session.setMCPPromptCommands([staleCommand]);
		expect(session.customCommands.map(command => command.command.name)).toContain("retired:prompt");
		spyOn(manager, "rediscoverAndConnect").mockResolvedValue({
			tools: [],
			errors: new Map(),
			connectedServers: [],
			exaApiKeys: [],
		});

		await session.reloadMCPResources();

		expect(session.mcpPromptCommands).toEqual([]);
		expect(session.customCommands.map(command => command.command.name)).not.toContain("retired:prompt");
	});

	it("serializes canonical plugin reloads through MCP rediscovery", async () => {
		const { session } = await createHarness([], { enableMCP: true });
		const manager = session.mcpManager;
		if (!manager) throw new Error("Expected owned MCP manager");
		const firstStarted = Promise.withResolvers<void>();
		const resumeFirst = Promise.withResolvers<void>();
		let calls = 0;
		let activeCalls = 0;
		let maximumActiveCalls = 0;
		spyOn(manager, "rediscoverAndConnect").mockImplementation(async () => {
			calls++;
			activeCalls++;
			maximumActiveCalls = Math.max(maximumActiveCalls, activeCalls);
			try {
				if (calls === 1) {
					firstStarted.resolve();
					await resumeFirst.promise;
				}
				return {
					tools: [],
					errors: new Map(),
					connectedServers: [],
					exaApiKeys: [],
				};
			} finally {
				activeCalls--;
			}
		});

		const firstReload = session.reloadPluginResources();
		await firstStarted.promise;
		const secondReload = session.reloadPluginResources();
		await Promise.resolve();
		expect(calls).toBe(1);

		resumeFirst.resolve();
		const results = await Promise.all([firstReload, secondReload]);

		expect(results.every(result => result?.state !== "failed")).toBe(true);
		expect(calls).toBe(2);
		expect(maximumActiveCalls).toBe(1);
	});

	it("serializes direct MCP reloads until tool publication completes", async () => {
		const { session } = await createHarness([], { enableMCP: true });
		const manager = session.mcpManager;
		if (!manager) throw new Error("Expected owned MCP manager");
		const rediscover = spyOn(manager, "rediscoverAndConnect").mockResolvedValue({
			tools: [],
			errors: new Map(),
			connectedServers: [],
			exaApiKeys: [],
		});
		const firstPublicationStarted = Promise.withResolvers<void>();
		const resumeFirstPublication = Promise.withResolvers<void>();
		const originalRefresh = session.refreshMCPTools.bind(session);
		let refreshCalls = 0;
		spyOn(session, "refreshMCPTools").mockImplementation(async tools => {
			refreshCalls++;
			if (refreshCalls === 1) {
				firstPublicationStarted.resolve();
				await resumeFirstPublication.promise;
			}
			await originalRefresh(tools);
		});

		const firstReload = session.reloadMCPResources();
		await firstPublicationStarted.promise;
		const secondReload = session.reloadMCPResources();
		await Promise.resolve();

		expect(rediscover).toHaveBeenCalledTimes(1);
		resumeFirstPublication.resolve();
		await Promise.all([firstReload, secondReload]);
		expect(rediscover).toHaveBeenCalledTimes(2);
		expect(refreshCalls).toBe(2);
	});

	it("keeps the owned MCP generation admitted through rediscovery", async () => {
		const { session } = await createHarness([], { enableMCP: true });
		const manager = session.mcpManager;
		if (!manager) throw new Error("Expected owned MCP manager");
		const staleTool = {
			name: "mcp__retired_search",
			label: "retired/search",
			description: "Tool from the retiring manager.",
			parameters: type({ query: "string" }),
			strict: true,
			mcpServerName: "retired",
			mcpToolName: "search",
			async execute() {
				return { content: [{ type: "text" as const, text: "stale" }] };
			},
		} as CustomTool;
		const discoveryStarted = Promise.withResolvers<void>();
		const resumeDiscovery = Promise.withResolvers<void>();
		spyOn(manager, "rediscoverAndConnect").mockImplementation(async () => {
			discoveryStarted.resolve();
			await resumeDiscovery.promise;
			return {
				tools: [staleTool],
				errors: new Map(),
				connectedServers: ["retired"],
				exaApiKeys: [],
			};
		});
		const disconnectRetired = spyOn(manager, "disconnectAll").mockResolvedValue();
		const replacement = new MCPManager(session.sessionManager.getCwd());

		const reload = session.reloadMCPResources();
		await discoveryStarted.promise;
		const replace = session.replaceMCPManager(replacement);
		await Promise.resolve();

		expect(session.mcpManager).toBe(manager);
		expect(disconnectRetired).not.toHaveBeenCalled();

		resumeDiscovery.resolve();
		const [reloadResult] = await Promise.all([reload, replace]);

		expect(reloadResult).toBeUndefined();
		expect(session.mcpManager).toBe(replacement);
		expect(disconnectRetired).toHaveBeenCalledTimes(1);
		expect(session.getAllToolNames()).not.toContain(staleTool.name);
	});

	it("merges concurrent runtime tool generations from the latest contribution snapshot", async () => {
		const { session } = await createHarness();
		const mcpTool = {
			name: "mcp__parallel_search",
			label: "parallel/search",
			description: "Concurrent MCP tool.",
			parameters: type({ query: "string" }),
			strict: true,
			mcpServerName: "parallel",
			mcpToolName: "search",
			async execute() {
				return { content: [{ type: "text" as const, text: "mcp" }] };
			},
		} as CustomTool;
		const template = session.getToolByName("read");
		if (!template) throw new Error("Expected built-in read tool");
		const rpcTool = {
			...template,
			name: "parallel_rpc_tool",
			label: "Parallel RPC Tool",
			description: "Concurrent RPC tool.",
		};

		await Promise.all([session.refreshMCPTools([mcpTool]), session.refreshRpcHostTools([rpcTool])]);

		expect(session.getAllToolNames()).toEqual(expect.arrayContaining([mcpTool.name, rpcTool.name]));
		expect(session.getEnabledToolNames()).toEqual(expect.arrayContaining([mcpTool.name, rpcTool.name]));
	});

	it("rejects an aborted queued MCP reload before it can rediscover", async () => {
		const { session } = await createHarness([], { enableMCP: true });
		const manager = session.mcpManager;
		if (!manager) throw new Error("Expected owned MCP manager");
		const firstStarted = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		let rediscoveryCount = 0;
		const rediscover = spyOn(manager, "rediscoverAndConnect").mockImplementation(async () => {
			rediscoveryCount++;
			if (rediscoveryCount === 1) {
				firstStarted.resolve();
				await releaseFirst.promise;
			}
			return {
				tools: [],
				errors: new Map(),
				connectedServers: [],
				exaApiKeys: [],
			};
		});

		const firstReload = session.reloadMCPResources();
		await firstStarted.promise;
		const controller = new AbortController();
		const queuedReload = session.reloadMCPResources(controller.signal);
		const reason = new Error("queued reload cancelled");
		controller.abort(reason);
		try {
			const outcome = await Promise.race([
				queuedReload.then(
					() => "resolved",
					error => error,
				),
				Bun.sleep(100).then(() => "timed out"),
			]);
			expect(outcome).toBe(reason);
			expect(rediscover).toHaveBeenCalledTimes(1);
		} finally {
			releaseFirst.resolve();
			await Promise.allSettled([firstReload, queuedReload]);
		}
		expect(rediscover).toHaveBeenCalledTimes(1);
	});

	it("removes stale MCP tools when a reload is cancelled after discovery", async () => {
		const { session } = await createHarness([], { enableMCP: true });
		const manager = session.mcpManager;
		if (!manager) throw new Error("Expected owned MCP manager");
		const staleTool = {
			name: "mcp__stale_search",
			label: "stale/search",
			description: "Search stale resources",
			parameters: type({ query: "string" }),
			strict: true,
			mcpServerName: "stale",
			mcpToolName: "search",
			async execute() {
				return { content: [{ type: "text" as const, text: "stale" }] };
			},
		} as CustomTool;
		await session.refreshMCPTools([staleTool]);
		expect(session.getAllToolNames()).toContain(staleTool.name);

		const abortController = new AbortController();
		const reason = new Error("reload cancelled");
		spyOn(manager, "rediscoverAndConnect").mockImplementation(async (_cwd, options) => {
			expect(options?.signal).toBeInstanceOf(AbortSignal);
			expect(options?.signal).not.toBe(abortController.signal);
			expect(options?.signal?.aborted).toBe(false);
			abortController.abort(reason);
			return {
				tools: [staleTool],
				errors: new Map(),
				connectedServers: ["stale"],
				exaApiKeys: [],
			};
		});

		await expect(session.reloadMCPResources(abortController.signal)).rejects.toBe(reason);
		expect(session.getAllToolNames()).not.toContain(staleTool.name);
		expect(session.getEnabledToolNames()).not.toContain(staleTool.name);
	});

	it("cancels a signal-less MCP reload during a hanging HTTP termination", async () => {
		const deleteStarted = Promise.withResolvers<void>();
		const hangingDelete = Promise.withResolvers<Response>();
		let initializeCount = 0;
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				if (request.method === "DELETE") {
					deleteStarted.resolve();
					return hangingDelete.promise;
				}
				if (request.method === "GET") return new Response(null, { status: 405 });
				const body = (await request.json()) as { id?: string | number; method: string };
				if (body.method === "initialize") {
					initializeCount++;
					return new Response(
						JSON.stringify({
							jsonrpc: "2.0",
							id: body.id,
							result: {
								protocolVersion: "2025-03-26",
								capabilities: { tools: {} },
								serverInfo: { name: "session-disposal-race", version: "1.0.0" },
							},
						}),
						{
							headers: {
								"Content-Type": "application/json",
								"Mcp-Session-Id": "session-disposal-race",
							},
						},
					);
				}
				if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
				if (body.method === "tools/list") {
					return new Response(
						JSON.stringify({
							jsonrpc: "2.0",
							id: body.id,
							result: { tools: [{ name: "ready", inputSchema: { type: "object" } }] },
						}),
						{ headers: { "Content-Type": "application/json" } },
					);
				}
				return new Response(null, { status: 404 });
			},
		});
		const { session } = await createHarness([], { enableMCP: true });
		const manager = session.mcpManager;
		if (!manager) throw new Error("Expected owned MCP manager");
		const connectedPublication = Promise.withResolvers<void>();
		const reloadPublication = Promise.withResolvers<void>();
		let reloadStarted = false;
		let publicationCount = 0;
		const originalNotification = session.refreshMCPToolsFromManagerNotification.bind(session);
		spyOn(session, "refreshMCPToolsFromManagerNotification").mockImplementation(async (tools, expectedManager) => {
			publicationCount++;
			try {
				await originalNotification(tools, expectedManager);
			} finally {
				if (reloadStarted) reloadPublication.resolve();
				else connectedPublication.resolve();
			}
		});
		try {
			const connected = await manager.connectServers(
				{
					hanging: {
						type: "http",
						url: `http://127.0.0.1:${server.port}`,
						timeout: 0,
					},
				},
				{},
			);
			expect(connected.errors).toEqual(new Map());
			const mcpToolName = manager.getTools()[0]?.name;
			if (!mcpToolName) throw new Error("Expected connected MCP tool");
			// A real HTTP transport is intentional here: this wall-clock guard proves
			// disposal interrupts a live termination DELETE instead of waiting for it.
			await withTimeout(connectedPublication.promise, 500, "Connected MCP tool publication did not settle");
			expect(session.getAllToolNames()).toContain(mcpToolName);

			reloadStarted = true;
			const reload = session.reloadMCPResources();
			await deleteStarted.promise;
			const disposal = session.dispose();
			const outcome = await withTimeout(
				reload.then(
					() => undefined,
					error => error,
				),
				500,
				"Signal-less MCP reload did not settle after disposal",
			);
			if (!(outcome instanceof Error)) throw new Error(`Expected disposal cancellation, got ${String(outcome)}`);
			expect(outcome.message).toBe("Agent session was disposed during MCP reload");
			await withTimeout(reloadPublication.promise, 500, "MCP empty publication did not settle");
			expect(publicationCount).toBe(2);
			expect(manager.getTools()).toEqual([]);
			expect(session.getAllToolNames()).not.toContain(mcpToolName);

			hangingDelete.resolve(new Response(null, { status: 202 }));
			await Promise.allSettled([reload, disposal]);
			await Promise.resolve();
			expect(initializeCount).toBe(1);
			expect(publicationCount).toBe(2);
			expect(manager.getTools()).toEqual([]);
			expect(session.getAllToolNames()).not.toContain(mcpToolName);
		} finally {
			hangingDelete.resolve(new Response(null, { status: 202 }));
			server.stop(true);
		}
	});

	it("does not construct a new extension generation for a skills-only reload", async () => {
		let extensionLoads = 0;
		const extension: ExtensionFactory = () => {
			extensionLoads++;
		};
		const { session } = await createHarness([extension]);
		const previousRunner = session.extensionRunner;

		const result = await session.reloadResources(["skills"]);

		expect(result?.state).not.toBe("failed");
		expect(extensionLoads).toBe(1);
		expect(session.extensionRunner).toBe(previousRunner);
	});

	it("keeps the applied extension generation when a discovered extension fails to reload", async () => {
		const extensionDir = TempDir.createSync("@pi-resource-extension-rollback-");
		const extensionPath = extensionDir.join("reloadable-extension.ts");
		try {
			await Bun.write(
				extensionPath,
				[
					"export default function(pi) {",
					"\tconst { Type } = pi.typebox;",
					"\tpi.registerTool({",
					'\t\tname: "reloadable_extension_tool",',
					'\t\tlabel: "Reloadable Extension Tool",',
					'\t\tdescription: "Tool from the applied extension generation.",',
					"\t\tparameters: Type.Object({}),",
					'\t\tasync execute() { return { content: [{ type: "text", text: "v1" }] }; },',
					"\t});",
					"}",
				].join("\n"),
			);
			const { session } = await createHarness([], { additionalExtensionPaths: [extensionPath] });
			const appliedRunner = session.extensionRunner;
			expect(session.getToolByName("reloadable_extension_tool")?.label).toBe("Reloadable Extension Tool");

			await Bun.write(extensionPath, 'export default function() { throw new Error("reload fixture failed"); }\n');
			const result = await session.reloadPluginResources();

			expect(result?.state).toBe("failed");
			expect(result?.diagnostics.some(diagnostic => diagnostic.message.includes("Extension reload aborted"))).toBe(
				true,
			);
			expect(session.extensionRunner).toBe(appliedRunner);
			expect(session.getToolByName("reloadable_extension_tool")?.label).toBe("Reloadable Extension Tool");
		} finally {
			await extensionDir.remove();
		}
	});

	it("rebinds borrowed UI and theme capabilities to the activated extension generation", async () => {
		const notifications: string[] = [];
		const extension: ExtensionFactory = pi => {
			pi.on("session_start", (_event, context) => {
				context.ui.notify("generation started");
			});
		};
		const { session, setToolUIContext } = await createHarness([extension]);
		const previousRunner = session.extensionRunner;
		if (!previousRunner) throw new Error("Expected extension runner");
		const uiContext: ExtensionUIContext = {
			...previousRunner.getUIContext(),
			notify: message => notifications.push(message),
		};
		setToolUIContext(uiContext, true);
		await initializeExtensions(session, {
			reportSendError: () => undefined,
			reportRuntimeError: () => undefined,
			uiContext,
		});
		expect(notifications).toEqual(["generation started"]);

		const stopThemeWatcher = spyOn(themeModule, "stopThemeWatcher");
		try {
			const result = await session.reloadResources(["extensions"]);
			expect(result?.state).toBe("applied");
			expect(session.extensionRunner).not.toBe(previousRunner);
			expect(session.extensionRunner?.getUIContext()).toBe(uiContext);
			expect(notifications).toEqual(["generation started", "generation started"]);
			expect(stopThemeWatcher).not.toHaveBeenCalled();
		} finally {
			stopThemeWatcher.mockRestore();
		}
	});

	it("preserves assigned extension flag values across reload generations", async () => {
		let defaultValue = "default-v1";
		const observedValues: Array<boolean | string | undefined> = [];
		const extension: ExtensionFactory = pi => {
			pi.registerFlag("--profile", { type: "string", default: defaultValue });
			pi.on("session_start", () => {
				observedValues.push(pi.getFlag("--profile"));
			});
		};
		const { session } = await createHarness([extension]);
		await initializeExtensions(session, {
			reportSendError: () => undefined,
			reportRuntimeError: () => undefined,
		});
		const previousRunner = session.extensionRunner;
		if (!previousRunner) throw new Error("Expected extension runner");
		expect(observedValues).toEqual(["default-v1"]);

		previousRunner.setFlagValue("--profile", "assigned");
		defaultValue = "default-v2";
		const result = await session.reloadResources(["extensions"]);

		expect(result?.state).toBe("applied");
		expect(session.extensionRunner).not.toBe(previousRunner);
		expect(session.extensionRunner?.getFlagValues().get("--profile")).toBe("assigned");
		expect(observedValues).toEqual(["default-v1", "assigned"]);
	});

	it("routes execution callbacks only through the applied extension generation", async () => {
		let desiredGeneration = "v1";
		const starts: string[] = [];
		const contexts: string[] = [];
		const shutdowns: string[] = [];
		const extension: ExtensionFactory = pi => {
			const generation = desiredGeneration;
			pi.on("session_start", () => {
				starts.push(generation);
			});
			pi.on("context", () => {
				contexts.push(generation);
			});
			pi.on("session_shutdown", () => {
				shutdowns.push(generation);
			});
		};
		const { session } = await createHarness([extension]);
		await initializeExtensions(session, {
			reportSendError: () => undefined,
			reportRuntimeError: () => undefined,
		});
		await session.convertMessagesToLlm([]);
		expect(starts).toEqual(["v1"]);
		expect(contexts).toEqual(["v1"]);

		desiredGeneration = "v2";
		const result = await session.reloadResources(["extensions"]);
		expect(result?.state).toBe("applied");
		expect(starts).toEqual(["v1", "v2"]);
		expect(shutdowns).toEqual(["v1"]);

		await session.convertMessagesToLlm([]);
		expect(contexts).toEqual(["v1", "v2"]);
	});

	it("runs extension activation after publication so it can admit nested resource changes", async () => {
		let desiredGeneration = "v1";
		let session: AgentSession | undefined;
		let nestedReloadCompleted = false;
		let requestNestedReload = true;
		const starts: string[] = [];
		const runtimeErrors: string[] = [];
		const v2Finished = Promise.withResolvers<void>();
		const extension: ExtensionFactory = pi => {
			const generation = desiredGeneration;
			pi.on("session_start", async () => {
				starts.push(generation);
				if (generation !== "v2" || !requestNestedReload) return;
				requestNestedReload = false;
				try {
					await pi.setActiveTools(["read"]);
					if (!session) throw new Error("Expected active session");
					await session.reload();
					nestedReloadCompleted = true;
				} finally {
					v2Finished.resolve();
				}
			});
		};
		const harness = await createHarness([extension], { toolNames: ["read", "grep"] });
		session = harness.session;
		await initializeExtensions(session, {
			reportSendError: () => undefined,
			reportRuntimeError: error => runtimeErrors.push(error.error),
		});
		expect(starts).toEqual(["v1"]);

		testSetExtensionHandlerTimeoutMs(500);
		try {
			desiredGeneration = "v2";
			const result = await session.reloadPluginResources();
			await v2Finished.promise;

			expect(result?.state).toBe("applied");
			expect(nestedReloadCompleted).toBe(true);
			expect(runtimeErrors).toEqual([]);
			expect(starts).toEqual(["v1", "v2", "v2"]);
			expect(session.getEnabledToolNames()).toContain("read");
			expect(session.getEnabledToolNames()).not.toContain("grep");
		} finally {
			testSetExtensionHandlerTimeoutMs(EXTENSION_HANDLER_TIMEOUT_MS);
		}
	});

	it("serializes a superseding extension reload behind in-flight publication", async () => {
		let desiredGeneration = "v1";
		const starts: string[] = [];
		const v2Started = Promise.withResolvers<void>();
		const releaseV2 = Promise.withResolvers<void>();
		const extension: ExtensionFactory = pi => {
			const generation = desiredGeneration;
			pi.on("session_start", async () => {
				starts.push(generation);
				if (generation === "v2") {
					v2Started.resolve();
					await releaseV2.promise;
				}
			});
		};
		const { session } = await createHarness([extension]);
		await initializeExtensions(session, {
			reportSendError: () => undefined,
			reportRuntimeError: () => undefined,
		});

		desiredGeneration = "v2";
		const v2Reload = session.reloadResources(["extensions"]);
		await v2Started.promise;
		try {
			desiredGeneration = "v3";
			const v3Reload = session.reloadResources(["extensions"]);
			await Bun.sleep(0);
			expect(starts).toEqual(["v1", "v2"]);

			releaseV2.resolve();
			const [v2Result, v3Result] = await Promise.all([v2Reload, v3Reload]);
			expect(v2Result?.state).toBe("applied");
			expect(v3Result?.state).toBe("applied");
			expect(starts).toEqual(["v1", "v2", "v3"]);
		} finally {
			releaseV2.resolve();
		}
	});

	it("rebuilds instructions from the activated tool generation", async () => {
		const toolDescription = "Fresh reload-only tool guidance marker.";
		let registerReloadTool = false;
		const extension: ExtensionFactory = pi => {
			if (!registerReloadTool) return;
			pi.registerTool({
				name: "reload_prompt_tool",
				label: "Reload Prompt Tool",
				description: toolDescription,
				parameters: pi.typebox.Type.Object({}),
				async execute() {
					return { content: [{ type: "text", text: "ok" }] };
				},
			});
		};
		const { session } = await createHarness([extension], { useDefaultSystemPrompt: true });
		expect(session.systemPrompt.join("\n")).not.toContain(toolDescription);

		registerReloadTool = true;
		const result = await session.reloadResources(["extensions"]);

		expect(result?.state).toBe("applied");
		expect(session.getEnabledToolNames()).toContain("reload_prompt_tool");
		expect(session.systemPrompt.join("\n")).toContain(toolDescription);
	});

	it("holds prompt-generation admission until the refreshed prompt is installed", async () => {
		let desiredGeneration = "v1";
		let pauseNextBuild = false;
		const buildStarted = Promise.withResolvers<void>();
		const resumeBuild = Promise.withResolvers<void>();
		const v2Discovered = Promise.withResolvers<void>();
		const backend: MemoryBackend = {
			id: "off",
			async start() {},
			async buildDeveloperInstructions() {
				if (pauseNextBuild) {
					pauseNextBuild = false;
					buildStarted.resolve();
					await resumeBuild.promise;
				}
				return undefined;
			},
			async clear() {},
			async enqueue() {},
		};
		const resolveMemoryBackend = spyOn(memoryBackendModule, "resolveMemoryBackend").mockResolvedValue(backend);
		try {
			const extension: ExtensionFactory = pi => {
				const generation = desiredGeneration;
				if (generation === "v2") v2Discovered.resolve();
				pi.registerTool({
					name: "admission_prompt_tool",
					label: `Admission Prompt Tool ${generation}`,
					description: "Prompt generation admission test tool.",
					parameters: pi.typebox.Type.Object({}),
					async execute() {
						return { content: [{ type: "text", text: generation }] };
					},
				});
			};
			const { session } = await createHarness([extension], {
				useDefaultSystemPrompt: true,
				toolNames: ["admission_prompt_tool"],
			});
			expect(session.systemPrompt.join("\n")).toContain("Admission Prompt Tool v1");

			pauseNextBuild = true;
			const refresh = session.refreshBaseSystemPrompt();
			await buildStarted.promise;
			desiredGeneration = "v2";
			let reloadSettled = false;
			const reload = session.reloadResources(["extensions"]);
			void reload.then(
				() => {
					reloadSettled = true;
				},
				() => {
					reloadSettled = true;
				},
			);
			await v2Discovered.promise;
			await Bun.sleep(0);
			expect(reloadSettled).toBe(false);

			resumeBuild.resolve();
			const [, result] = await Promise.all([refresh, reload]);

			expect(result?.state).toBe("applied");
			expect(session.systemPrompt.join("\n")).toContain("Admission Prompt Tool v2");
			expect(session.systemPrompt.join("\n")).not.toContain("Admission Prompt Tool v1");
		} finally {
			resumeBuild.resolve();
			resolveMemoryBackend.mockRestore();
		}
	});

	it("preserves an RPC host tool when a reloaded extension claims the same name", async () => {
		const toolName = "rpc_owned_tool";
		let registerConflictingExtensionTool = false;
		const extension: ExtensionFactory = pi => {
			if (!registerConflictingExtensionTool) return;
			pi.registerTool({
				name: toolName,
				label: "Extension Tool",
				description: "Conflicts with the live RPC host tool.",
				parameters: pi.typebox.Type.Object({}),
				async execute() {
					return { content: [{ type: "text", text: "extension" }] };
				},
			});
		};
		const { session } = await createHarness([extension]);
		const template = session.getToolByName("read");
		if (!template) throw new Error("Expected built-in read tool");
		await session.refreshRpcHostTools([
			{
				...template,
				name: toolName,
				label: "RPC Host Tool",
			},
		]);
		expect(session.getToolByName(toolName)?.label).toBe("RPC Host Tool");

		registerConflictingExtensionTool = true;
		const result = await session.reloadResources(["extensions"]);

		expect(result?.state).toBe("applied");
		expect(session.getToolByName(toolName)?.label).toBe("RPC Host Tool");

		await session.refreshRpcHostTools([]);
		expect(session.getToolByName(toolName)?.label).toBe("Extension Tool");
		expect(session.getEnabledToolNames()).toContain(toolName);
	});
	it("restores a shadowed extension tool after its runtime MCP contribution retires", async () => {
		const toolName = "mcp__shadow_search";
		let registerConflictingExtensionTool = false;
		const extension: ExtensionFactory = pi => {
			if (!registerConflictingExtensionTool) return;
			pi.registerTool({
				name: toolName,
				label: "Extension MCP-shaped Tool",
				description: "Remains available beneath the live MCP contribution.",
				parameters: pi.typebox.Type.Object({}),
				async execute() {
					return { content: [{ type: "text", text: "extension" }] };
				},
			});
		};
		const { session } = await createHarness([extension]);
		const runtimeTool = {
			name: toolName,
			label: "Runtime MCP Tool",
			description: "Live MCP search tool.",
			parameters: type({ query: "string" }),
			strict: true,
			mcpServerName: "shadow",
			mcpToolName: "search",
			async execute() {
				return { content: [{ type: "text" as const, text: "runtime" }] };
			},
		} as CustomTool;
		await session.refreshMCPTools([runtimeTool]);
		expect(session.getToolByName(toolName)?.label).toBe("Runtime MCP Tool");

		registerConflictingExtensionTool = true;
		const result = await session.reloadResources(["extensions"]);
		expect(result?.state).toBe("applied");
		expect(session.getToolByName(toolName)?.label).toBe("Runtime MCP Tool");

		await session.refreshMCPTools([]);
		expect(session.getToolByName(toolName)?.label).toBe("Extension MCP-shaped Tool");
		expect(session.getEnabledToolNames()).toContain(toolName);
	});

	it("does not route a retired command's late failure through the replacement generation", async () => {
		const extension: ExtensionFactory = pi => {
			pi.registerCommand("reload-then-fail", {
				handler: async (_args, context) => {
					await context.reload();
					throw new Error("retired command failed");
				},
			});
		};
		const { session } = await createHarness([extension]);
		const errors: string[] = [];
		await initializeExtensions(session, {
			reportSendError: () => undefined,
			reportRuntimeError: error => errors.push(error.error),
		});
		const previousRunner = session.extensionRunner;

		const forwarded = await session.prompt("/reload-then-fail");

		expect(forwarded).toBe(false);
		expect(session.extensionRunner).not.toBe(previousRunner);
		expect(errors).toEqual([]);
	});
});
