import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { ExtensionRuntime, loadExtensionFromFactory } from "../src/extensibility/extensions/loader";
import {
	ExtensionRunner,
	SESSION_SHUTDOWN_HANDLER_TIMEOUT_MS,
	testSetSessionShutdownHandlerTimeoutMs,
} from "../src/extensibility/extensions/runner";
import { ExtensionToolWrapper } from "../src/extensibility/extensions/wrapper";
import { Type } from "../src/extensibility/typebox";
import type { MemoryRuntimeContext } from "../src/memory-backend";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { EventBus } from "../src/utils/event-bus";

function testActions(sessionName = "generation") {
	return {
		sendMessage: () => {},
		sendUserMessage: () => {},
		appendEntry: () => {},
		setLabel: () => {},
		getActiveTools: () => [],
		getAllTools: () => [],
		setActiveTools: async () => {},
		getCommands: () => [],
		setModel: async () => false,
		getThinkingLevel: () => undefined,
		setThinkingLevel: () => {},
		getSessionName: () => sessionName,
		setSessionName: async () => {},
	};
}

function testContextActions(isIdle: () => boolean = () => true) {
	return {
		getModel: () => undefined,
		isIdle,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: async () => {},
		getSystemPrompt: () => [],
	};
}

describe("ExtensionRunner logical lifecycle", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-runner-lifecycle-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	it("activates and deactivates each generation exactly once", async () => {
		const runtime = new ExtensionRuntime();
		let starts = 0;
		let shutdowns = 0;
		let ordinaryEvents = 0;
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("session_start", () => {
					starts += 1;
				});
				pi.on("session_shutdown", () => {
					shutdowns += 1;
				});
				pi.on("agent_start", () => {
					ordinaryEvents += 1;
				});
			},
			tempDir.path(),
			new EventBus(),
			runtime,
		);
		const runner = new ExtensionRunner(
			[extension],
			runtime,
			tempDir.path(),
			SessionManager.inMemory(),
			modelRegistry,
		);
		const actions = {
			sendMessage: () => {},
			sendUserMessage: () => {},
			appendEntry: () => {},
			setLabel: () => {},
			getActiveTools: () => [],
			getAllTools: () => [],
			setActiveTools: async () => {},
			getCommands: () => [],
			setModel: async () => false,
			getThinkingLevel: () => undefined,
			setThinkingLevel: () => {},
			getSessionName: () => "generation",
			setSessionName: async () => {},
		};
		const contextActions = {
			getModel: () => undefined,
			isIdle: () => false,
			abort: () => {},
			hasPendingMessages: () => true,
			shutdown: () => {},
			getContextUsage: () => undefined,
			compact: async () => {},
			getSystemPrompt: () => ["generation"],
		};

		expect(runner.isActive).toBe(false);
		await runner.deactivate();
		expect(shutdowns).toBe(0);
		await runner.activate(actions, contextActions);
		expect(runner.isActive).toBe(true);
		expect(starts).toBe(1);
		await runner.activate();
		await runner.emit({ type: "session_start" });
		expect(starts).toBe(1);
		await runner.emit({ type: "agent_start" });
		expect(ordinaryEvents).toBe(1);

		await Promise.all([runner.deactivate(), runner.deactivate()]);
		expect(runner.isActive).toBe(false);
		expect(shutdowns).toBe(1);
		await runner.emit({ type: "agent_start" });
		await runner.emit({ type: "session_shutdown" });
		expect(ordinaryEvents).toBe(1);
		expect(shutdowns).toBe(1);
		expect(runner.createContext().isIdle()).toBe(true);
		expect(runtime.getSessionName()).toBeUndefined();

		await runner.activate(actions, contextActions);
		expect(runner.isActive).toBe(true);
		expect(starts).toBe(2);
		await runner.deactivate();
		expect(shutdowns).toBe(2);
	});
	it("clears generation timers when shutdown handling throws", async () => {
		vi.useFakeTimers();
		try {
			const runtime = new ExtensionRuntime();
			let ticks = 0;
			const extension = await loadExtensionFromFactory(
				pi => {
					pi.on("session_start", (_event, ctx) => {
						ctx.setInterval(() => {
							ticks += 1;
						}, 10);
					});
					pi.on("session_shutdown", () => {
						throw new Error("shutdown failure");
					});
				},
				tempDir.path(),
				new EventBus(),
				runtime,
			);
			const runner = new ExtensionRunner(
				[extension],
				runtime,
				tempDir.path(),
				SessionManager.inMemory(),
				modelRegistry,
			);
			runner.initialize(testActions(), testContextActions());
			await runner.activate();
			const retiredContext = runner.createContext();
			vi.advanceTimersByTime(25);
			expect(ticks).toBe(2);

			await runner.deactivate();
			vi.advanceTimersByTime(100);
			expect(ticks).toBe(2);
			retiredContext.setTimeout(() => {
				ticks += 10;
			}, 10);
			vi.advanceTimersByTime(100);
			expect(ticks).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("blocks delayed shutdown handlers from mutating the session manager", async () => {
		vi.useFakeTimers();
		testSetSessionShutdownHandlerTimeoutMs(1);
		try {
			const runtime = new ExtensionRuntime();
			const sessionManager = SessionManager.inMemory();
			const saveArtifact = vi.spyOn(sessionManager, "saveArtifact");
			const release = Promise.withResolvers<void>();
			let lateError: unknown;
			const lateAttempt = Promise.withResolvers<void>();
			const extension = await loadExtensionFromFactory(
				pi => {
					pi.on("session_shutdown", async (_event, ctx) => {
						await release.promise;
						try {
							await ctx.sessionManager.saveArtifact("late", "shutdown");
						} catch (error) {
							lateError = error;
						} finally {
							lateAttempt.resolve();
						}
					});
				},
				tempDir.path(),
				new EventBus(),
				runtime,
			);
			const runner = new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry);
			runner.initialize(testActions(), testContextActions());
			await runner.activate();

			const deactivation = runner.deactivate();
			vi.advanceTimersByTime(1);
			await deactivation;

			release.resolve();
			await lateAttempt.promise;
			expect(saveArtifact).not.toHaveBeenCalled();
			expect(lateError).toBeInstanceOf(Error);
		} finally {
			vi.restoreAllMocks();
			testSetSessionShutdownHandlerTimeoutMs(SESSION_SHUTDOWN_HANDLER_TIMEOUT_MS);
			vi.useRealTimers();
		}
	});

	it("gates retained context memory to its generation", async () => {
		let memory = {} as MemoryRuntimeContext;
		const runtime = new ExtensionRuntime();
		const runner = new ExtensionRunner(
			[],
			runtime,
			tempDir.path(),
			SessionManager.inMemory(),
			modelRegistry,
			() => memory,
		);
		runner.initialize(testActions(), testContextActions());
		await runner.activate();
		const context = runner.createContext();
		expect(context.memory).toBe(memory);

		const replacement = {} as MemoryRuntimeContext;
		memory = replacement;
		expect(context.memory).toBe(replacement);

		await runner.deactivate();
		expect(context.memory).toBeUndefined();
	});

	it("does not self-await when shutdown handlers request a reload", async () => {
		const runtime = new ExtensionRuntime();
		let reload: (() => Promise<void>) | undefined;
		let reloads = 0;
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("session_shutdown", async () => {
					await reload?.();
				});
			},
			tempDir.path(),
			new EventBus(),
			runtime,
		);
		const runner = new ExtensionRunner(
			[extension],
			runtime,
			tempDir.path(),
			SessionManager.inMemory(),
			modelRegistry,
		);
		runner.initialize(testActions(), testContextActions(), {
			waitForIdle: async () => {},
			newSession: async () => ({ cancelled: false }),
			branch: async () => ({ cancelled: false }),
			navigateTree: async () => ({ cancelled: false }),
			compact: async () => {},
			switchSession: async () => ({ cancelled: false }),
			reload: async () => {
				reloads += 1;
				await runner.deactivate();
			},
			getContextUsage: () => undefined,
		});
		reload = runner.createCommandContext().reload;
		await runner.activate();

		await runner.deactivate();
		expect(reloads).toBe(0);
	});

	it("revokes generation mutations before dispatching session shutdown", async () => {
		const runtime = new ExtensionRuntime();
		const mutations: string[] = [];
		const readableSessionIds: string[] = [];
		let sessionManagerMutationError: unknown;
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("session_shutdown", async (_event, ctx) => {
					pi.sendMessage({ customType: "shutdown", content: "stale" });
					pi.sendUserMessage("stale");
					pi.appendEntry("shutdown", { stale: true });
					await pi.setActiveTools([]);
					pi.setThinkingLevel("off");
					await pi.setSessionName("stale");
					ctx.abort();
					ctx.shutdown();
					await ctx.compact();
					readableSessionIds.push(ctx.sessionManager.getSessionId());
					try {
						await ctx.sessionManager.saveArtifact("stale", "shutdown");
					} catch (error) {
						sessionManagerMutationError = error;
					}
				});
			},
			tempDir.path(),
			new EventBus(),
			runtime,
		);
		const sessionManager = SessionManager.inMemory();
		const runner = new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry);
		runner.initialize(
			{
				...testActions(),
				sendMessage: () => mutations.push("sendMessage"),
				sendUserMessage: () => mutations.push("sendUserMessage"),
				appendEntry: () => mutations.push("appendEntry"),
				setActiveTools: async () => {
					mutations.push("setActiveTools");
				},
				setThinkingLevel: () => mutations.push("setThinkingLevel"),
				setSessionName: async () => {
					mutations.push("setSessionName");
				},
			},
			{
				...testContextActions(),
				abort: () => mutations.push("abort"),
				shutdown: () => mutations.push("shutdown"),
				compact: async () => {
					mutations.push("compact");
				},
			},
		);
		await runner.activate();

		await runner.deactivate();

		expect(mutations).toEqual([]);
		expect(readableSessionIds).toEqual([sessionManager.getSessionId()]);
		expect(sessionManagerMutationError).toBeInstanceOf(Error);
	});

	it("drops error listeners with the deactivated generation", async () => {
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("agent_start", () => {
					throw new Error("generation error");
				});
			},
			tempDir.path(),
			new EventBus(),
			runtime,
		);
		const runner = new ExtensionRunner(
			[extension],
			runtime,
			tempDir.path(),
			SessionManager.inMemory(),
			modelRegistry,
		);
		const errors: string[] = [];
		runner.initialize(testActions(), testContextActions());
		runner.onError(error => errors.push(error.error));
		await runner.activate();
		await runner.emit({ type: "agent_start" });
		expect(errors).toEqual(["generation error"]);
		await runner.deactivate();
		await expect(runner.activate()).rejects.toThrow("initialized");
		runner.initialize(testActions(), testContextActions());
		await runner.activate();
		await runner.emit({ type: "agent_start" });
		expect(errors).toEqual(["generation error"]);
		await runner.deactivate();
	});
	it("transfers initialized configuration and listeners without coupling deactivation", async () => {
		const sourceRuntime = new ExtensionRuntime();
		const targetRuntime = new ExtensionRuntime();
		const notifications: string[] = [];
		const statusWrites: Array<string | undefined> = [];
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("session_start", (_event, ctx) => {
					ctx.ui.notify("started");
					ctx.ui.setStatus("generation", "started");
				});
				pi.on("session_shutdown", (_event, ctx) => {
					ctx.ui.setStatus("generation", undefined);
				});
				pi.on("agent_start", () => {
					throw new Error("transferred generation error");
				});
			},
			tempDir.path(),
			new EventBus(),
			sourceRuntime,
		);
		const source = new ExtensionRunner(
			[extension],
			sourceRuntime,
			tempDir.path(),
			SessionManager.inMemory(),
			modelRegistry,
		);
		const target = new ExtensionRunner(
			[extension],
			targetRuntime,
			tempDir.path(),
			SessionManager.inMemory(),
			modelRegistry,
		);
		const uiContext = {
			...source.getUIContext(),
			notify: (message: string) => notifications.push(message),
			setStatus: (_key: string, text: string | undefined) => statusWrites.push(text),
		};
		const actions = {
			sendMessage: () => {},
			sendUserMessage: () => {},
			appendEntry: () => {},
			setLabel: () => {},
			getActiveTools: () => [],
			getAllTools: () => [],
			setActiveTools: async () => {},
			getCommands: () => [],
			setModel: async () => false,
			getThinkingLevel: () => undefined,
			setThinkingLevel: () => {},
			getSessionName: () => "transferred",
			setSessionName: async () => {},
		};
		const contextActions = {
			getModel: () => undefined,
			isIdle: () => false,
			abort: () => {},
			hasPendingMessages: () => false,
			shutdown: () => {},
			getContextUsage: () => undefined,
			compact: async () => {},
			getSystemPrompt: () => ["transferred"],
		};
		const errors: string[] = [];
		source.initialize(actions, contextActions, undefined, uiContext);
		source.onError(error => errors.push(error.error));
		await source.activate();
		target.prepareActivationFrom(source);
		expect(target.isActive).toBe(false);
		expect(target.hasPendingActivation).toBe(true);
		expect(notifications).toEqual(["started"]);
		await target.startActivation();
		expect(target.isActive).toBe(true);
		expect(notifications).toEqual(["started"]);
		await target.emitSessionStart();
		expect(notifications).toEqual(["started", "started"]);
		expect(statusWrites).toEqual(["started", "started"]);
		expect(target.getUIContext()).toBe(uiContext);
		expect(target.createContext().isIdle()).toBe(false);
		expect(target.createContext().hasUI).toBe(true);
		expect(targetRuntime.getSessionName()).toBe("transferred");

		await target.emit({ type: "agent_start" });
		expect(errors).toEqual(["transferred generation error"]);
		await source.deactivate();
		expect(source.isActive).toBe(false);
		expect(statusWrites).toEqual(["started", "started"]);
		expect(target.createContext().isIdle()).toBe(false);
		await target.emit({ type: "agent_start" });
		expect(errors).toEqual(["transferred generation error", "transferred generation error"]);

		await target.deactivate();
		expect(statusWrites).toEqual(["started", "started", undefined]);
		const uninitialized = new ExtensionRunner(
			[],
			new ExtensionRuntime(),
			tempDir.path(),
			SessionManager.inMemory(),
			modelRegistry,
		);
		await expect(target.activateFrom(uninitialized)).rejects.toThrow("uninitialized");
	});
	it("binds tool callbacks to one extension generation for the full execution", async () => {
		const events: string[] = [];
		const createRunner = async (generation: string) => {
			const runtime = new ExtensionRuntime();
			const extension = await loadExtensionFromFactory(
				pi => {
					pi.on("tool_call", () => {
						events.push(`${generation}:call`);
					});
					pi.on("tool_result", () => {
						events.push(`${generation}:result`);
					});
				},
				tempDir.path(),
				new EventBus(),
				runtime,
			);
			const runner = new ExtensionRunner(
				[extension],
				runtime,
				tempDir.path(),
				SessionManager.inMemory(),
				modelRegistry,
			);
			runner.initialize(testActions(generation), testContextActions());
			await runner.activate();
			return runner;
		};
		const first = await createRunner("first");
		const second = await createRunner("second");
		let current = first;
		const tool: AgentTool = {
			name: "generation_probe",
			label: "Generation Probe",
			description: "Switches the dynamic runner source during execution.",
			parameters: Type.Object({}),
			execute: async () => {
				current = second;
				return { content: [{ type: "text", text: "done" }] };
			},
		};
		const wrapped = new ExtensionToolWrapper(tool, () => current);

		await wrapped.execute("probe", {});

		expect(events).toEqual(["first:call", "first:result"]);
		await Promise.all([first.deactivate(), second.deactivate()]);
	});

	it("rejects command-context reloads during an active turn", async () => {
		const runtime = new ExtensionRuntime();
		const runner = new ExtensionRunner([], runtime, tempDir.path(), SessionManager.inMemory(), modelRegistry);
		let idle = false;
		let reloads = 0;
		runner.initialize(
			{
				sendMessage: () => {},
				sendUserMessage: () => {},
				appendEntry: () => {},
				setLabel: () => {},
				getActiveTools: () => [],
				getAllTools: () => [],
				setActiveTools: async () => {},
				getCommands: () => [],
				setModel: async () => false,
				getThinkingLevel: () => undefined,
				setThinkingLevel: () => {},
				getSessionName: () => undefined,
				setSessionName: async () => {},
			},
			{
				getModel: () => undefined,
				isIdle: () => idle,
				abort: () => {},
				hasPendingMessages: () => false,
				shutdown: () => {},
				getContextUsage: () => undefined,
				compact: async () => {},
				getSystemPrompt: () => [],
			},
			{
				getContextUsage: () => undefined,
				waitForIdle: async () => {},
				newSession: async () => ({ cancelled: false }),
				branch: async () => ({ cancelled: false }),
				navigateTree: async () => ({ cancelled: false }),
				compact: async () => {},
				switchSession: async () => ({ cancelled: false }),
				reload: async () => {
					reloads += 1;
				},
			},
		);

		const context = runner.createCommandContext();
		await expect(context.reload()).rejects.toThrow("while the agent is running");
		expect(reloads).toBe(0);

		idle = true;
		await context.reload();
		expect(reloads).toBe(1);
	});
});
