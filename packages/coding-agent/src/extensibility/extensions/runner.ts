/**
 * Extension runner - executes extensions and manages their lifecycle.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { CredentialDisabledEvent, ImageContent, Model, ProviderResponseMetadata } from "@oh-my-pi/pi-ai";
import type { KeyId } from "@oh-my-pi/pi-tui";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import type { LocalProtocolOptions } from "../../internal-urls/local-protocol";
import type { MemoryRuntimeContext } from "../../memory-backend";
import { type Theme, theme } from "../../modes/theme/theme";
import type { ReadonlySessionManager, SessionManager } from "../../session/session-manager";
import type { BranchHandler, NavigateTreeHandler, NewSessionHandler } from "../session-handler-types";
import { ManagedTimers } from "./managed-timers";
import { createExtensionModelQuery } from "./model-api";
import type {
	AfterProviderResponseEvent,
	AssistantThinkingRenderer,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	BeforeProviderRequestEvent,
	BeforeProviderRequestEventResult,
	CompactOptions,
	ContextEvent,
	ContextEventResult,
	ContextUsage,
	Extension,
	ExtensionActions,
	ExtensionCommandContext,
	ExtensionCommandContextActions,
	ExtensionContext,
	ExtensionContextActions,
	ExtensionError,
	ExtensionEvent,
	ExtensionFlag,
	ExtensionRuntime,
	ExtensionShortcut,
	ExtensionUIContext,
	InputEvent,
	InputEventResult,
	MessageRenderer,
	RegisteredCommand,
	RegisteredTool,
	ResourcesDiscoverEvent,
	ResourcesDiscoverResult,
	SessionBeforeBranchResult,
	SessionBeforeCompactResult,
	SessionBeforeSwitchResult,
	SessionBeforeTreeResult,
	SessionCompactingResult,
	SessionStopEvent,
	SessionStopEventResult,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
	ToolResultEventResult,
	UserBashEvent,
	UserBashEventResult,
	UserPythonEvent,
	UserPythonEventResult,
} from "./types";

/** Combined result from all before_agent_start handlers */
interface BeforeAgentStartCombinedResult {
	messages?: NonNullable<BeforeAgentStartEventResult["message"]>[];
	systemPrompt?: string[];
}

export type ExtensionErrorListener = (error: ExtensionError) => void;

export const EXTENSION_HANDLER_TIMEOUT_MS = 30_000;
let extensionHandlerTimeoutMs = EXTENSION_HANDLER_TIMEOUT_MS;

export function testSetExtensionHandlerTimeoutMs(timeoutMs: number): void {
	extensionHandlerTimeoutMs = timeoutMs;
}

/**
 * Dedicated cap for `session_shutdown` handlers. The generic 30s budget is
 * appropriate for events extensions can observe (e.g. `session_start`,
 * `before_provider_request`), but `session_shutdown` is fire-and-forget
 * teardown — extensions receive no result and the user has already asked to
 * leave. A hung handler (e.g. an extension waiting on a stuck IPC pipe to a
 * companion app) MUST NOT hold Ctrl+C / `/exit` hostage for the full window.
 * See issue #2600.
 */
export const SESSION_SHUTDOWN_HANDLER_TIMEOUT_MS = 2_000;
let sessionShutdownHandlerTimeoutMs = SESSION_SHUTDOWN_HANDLER_TIMEOUT_MS;

export function testSetSessionShutdownHandlerTimeoutMs(timeoutMs: number): void {
	sessionShutdownHandlerTimeoutMs = timeoutMs;
}

/** Per-event handler budget. Defaults to the generic cap; `session_shutdown`
 *  uses its own short cap so teardown stays prompt. */
function handlerTimeoutForEvent(eventType: string): number {
	return eventType === "session_shutdown" ? sessionShutdownHandlerTimeoutMs : extensionHandlerTimeoutMs;
}

const EXTENSION_HANDLER_TIMEOUT = Symbol("extensionHandlerTimeout");

/**
 * Race `work` against a `timeoutMs` budget, clearing the pending timer the
 * instant the work settles.
 *
 * We deliberately avoid `Bun.sleep(timeoutMs).then(...)` here: that leaves an
 * uncancellable timer registered with the event loop, so every successful
 * handler race leaks a timer that keeps the process alive until the deadline
 * fires — up to the default 30s cap, which stalls non-interactive CLI exit
 * after any subscribed `tool_call`/`tool_result` handler runs (issue #3948
 * review, `chatgpt-codex-connector[bot]`). `setTimeout` returns a handle we
 * can `clearTimeout` on the winning branch.
 */
async function raceHandlerWithTimeout<T>(
	work: Promise<T>,
	timeoutMs: number,
): Promise<T | typeof EXTENSION_HANDLER_TIMEOUT> {
	const { promise: timeoutPromise, resolve: resolveTimeout } =
		Promise.withResolvers<typeof EXTENSION_HANDLER_TIMEOUT>();
	const timer = setTimeout(() => resolveTimeout(EXTENSION_HANDLER_TIMEOUT), timeoutMs);
	try {
		return await Promise.race([work, timeoutPromise]);
	} finally {
		clearTimeout(timer);
	}
}

const MAX_PENDING_CREDENTIAL_DISABLED = 32;

/**
 * Events handled by the generic emit() method.
 * Events with dedicated emitXxx() methods are excluded for stronger type safety.
 */
type RunnerEmitEvent = Exclude<
	ExtensionEvent,
	| ToolCallEvent
	| ToolResultEvent
	| UserBashEvent
	| ContextEvent
	| BeforeProviderRequestEvent
	| AfterProviderResponseEvent
	| BeforeAgentStartEvent
	| ResourcesDiscoverEvent
	| InputEvent
>;

type SessionBeforeEvent = Extract<
	RunnerEmitEvent,
	{ type: "session_before_switch" | "session_before_branch" | "session_before_compact" | "session_before_tree" }
>;

type SessionBeforeEventResult =
	| SessionBeforeSwitchResult
	| SessionBeforeBranchResult
	| SessionBeforeCompactResult
	| SessionBeforeTreeResult;

type RunnerEmitResult<TEvent extends RunnerEmitEvent> = TEvent extends { type: "session_before_switch" }
	? SessionBeforeSwitchResult | undefined
	: TEvent extends { type: "session_before_branch" }
		? SessionBeforeBranchResult | undefined
		: TEvent extends { type: "session_before_compact" }
			? SessionBeforeCompactResult | undefined
			: TEvent extends { type: "session_before_tree" }
				? SessionBeforeTreeResult | undefined
				: TEvent extends { type: "session.compacting" }
					? SessionCompactingResult | undefined
					: TEvent extends { type: "session_stop" }
						? SessionStopEventResult | undefined
						: undefined;

// Session-lifecycle handler types live once in session-handler-types (imported
// above for local use); re-exported here to keep this module's public API stable.
export type { BranchHandler, NavigateTreeHandler, NewSessionHandler };

export type SwitchSessionHandler = (sessionPath: string) => Promise<{ cancelled: boolean }>;

export type ShutdownHandler = () => void;

/**
 * Emit `session_shutdown` and clear timers owned by an extension runner.
 *
 * Returns whether any shutdown handlers were present. Timer cleanup runs even
 * when a handler fails so extension background work cannot outlive its host.
 */
export async function emitSessionShutdownEvent(extensionRunner: ExtensionRunner | undefined): Promise<boolean> {
	if (!extensionRunner) return false;
	try {
		if (!extensionRunner.hasHandlers("session_shutdown")) return false;
		await extensionRunner.emit({
			type: "session_shutdown",
		});
		return true;
	} finally {
		extensionRunner.clearManagedTimers();
	}
}

const noOpUIContext: ExtensionUIContext = {
	select: async (_title, _options, _dialogOptions) => undefined,
	confirm: async (_title, _message, _dialogOptions) => false,
	input: async (_title, _placeholder, _dialogOptions) => undefined,
	notify: () => {},
	onTerminalInput: () => () => {},
	setStatus: () => {},
	setWorkingMessage: () => {},
	setWidget: () => {},
	setFooter: () => {},
	setHeader: () => {},
	setTitle: () => {},
	custom: async () => undefined as never,
	setEditorText: () => {},
	pasteToEditor: () => {},
	getEditorText: () => "",
	editor: async () => undefined,
	addAutocompleteProvider: () => {},
	setEditorComponent: () => {},
	get theme() {
		return theme;
	},
	getAllThemes: () => Promise.resolve([]),
	getTheme: () => Promise.resolve(undefined),
	setTheme: (_theme: string | Theme) => Promise.resolve({ success: false, error: "UI not available" }),
	getToolsExpanded: () => false,
	setToolsExpanded: () => {},
};

const uiContextLeaseOwners = new WeakMap<ExtensionUIContext, object>();
const MUTATING_SESSION_MANAGER_MEMBERS = new Set<PropertyKey>([
	"getArtifactManager",
	"allocateArtifactPath",
	"saveArtifact",
	"putBlob",
	"putBlobSync",
]);

function createLeasedUIContext(target: ExtensionUIContext, owner: object): ExtensionUIContext {
	const isOwner = () => uiContextLeaseOwners.get(target) === owner;
	const custom: ExtensionUIContext["custom"] = (factory, options) =>
		isOwner() ? target.custom(factory, options) : noOpUIContext.custom(factory, options);
	const leased: ExtensionUIContext = {
		timeoutStartsOnPresentation: target.timeoutStartsOnPresentation,
		select: (title, options, dialogOptions) =>
			isOwner() ? target.select(title, options, dialogOptions) : noOpUIContext.select(title, options, dialogOptions),
		confirm: (title, message, dialogOptions) =>
			isOwner()
				? target.confirm(title, message, dialogOptions)
				: noOpUIContext.confirm(title, message, dialogOptions),
		input: (title, placeholder, dialogOptions) =>
			isOwner()
				? target.input(title, placeholder, dialogOptions)
				: noOpUIContext.input(title, placeholder, dialogOptions),
		askDialog: (questions, dialogOptions) =>
			isOwner() && target.askDialog ? target.askDialog(questions, dialogOptions) : Promise.resolve(undefined),
		notify: (message, type) => {
			if (isOwner()) target.notify(message, type);
		},
		onTerminalInput: handler => (isOwner() ? target.onTerminalInput(handler) : () => {}),
		setStatus: (key, text) => {
			if (isOwner()) target.setStatus(key, text);
		},
		setWorkingMessage: message => {
			if (isOwner()) target.setWorkingMessage(message);
		},
		setWidget: (key, content, options) => {
			if (isOwner()) target.setWidget(key, content, options);
		},
		setFooter: factory => {
			if (isOwner()) target.setFooter(factory);
		},
		setHeader: factory => {
			if (isOwner()) target.setHeader(factory);
		},
		setTitle: title => {
			if (isOwner()) target.setTitle(title);
		},
		custom,
		setEditorText: text => {
			if (isOwner()) target.setEditorText(text);
		},
		pasteToEditor: text => {
			if (isOwner()) target.pasteToEditor(text);
		},
		getEditorText: () => (isOwner() ? target.getEditorText() : noOpUIContext.getEditorText()),
		editor: (title, prefill, dialogOptions, editorOptions) =>
			isOwner()
				? target.editor(title, prefill, dialogOptions, editorOptions)
				: noOpUIContext.editor(title, prefill, dialogOptions, editorOptions),
		addAutocompleteProvider: factory => {
			if (isOwner()) target.addAutocompleteProvider(factory);
		},
		setEditorComponent: factory => {
			if (isOwner()) target.setEditorComponent(factory);
		},
		get theme() {
			return target.theme;
		},
		getAllThemes: () => target.getAllThemes(),
		getTheme: name => target.getTheme(name),
		setTheme: themeArg =>
			isOwner()
				? target.setTheme(themeArg)
				: Promise.resolve({ success: false, error: "Extension UI generation is no longer active" }),
		getToolsExpanded: () => (isOwner() ? target.getToolsExpanded() : noOpUIContext.getToolsExpanded()),
		setToolsExpanded: expanded => {
			if (isOwner()) target.setToolsExpanded(expanded);
		},
	};
	return leased;
}

interface ExtensionRunnerActivationConfig {
	actions: ExtensionActions;
	contextActions: ExtensionContextActions;
	commandContextActions?: ExtensionCommandContextActions;
	uiContext?: ExtensionUIContext;
}

const NOOP_TIMER = {} as Timer;

export class ExtensionRunner {
	#uiContext: ExtensionUIContext;
	#leasedUiContext: ExtensionUIContext;
	#uiContextLeaseOwner: object | undefined;
	#errorListeners: Set<ExtensionErrorListener> = new Set();
	#getModel: () => Model | undefined = () => undefined;
	#isIdleFn: () => boolean = () => true;
	#waitForIdleFn: () => Promise<void> = async () => {};
	#abortFn: () => void = () => {};
	#hasPendingMessagesFn: () => boolean = () => false;
	#getContextUsageFn: () => ContextUsage | undefined = () => undefined;
	#compactFn: (instructionsOrOptions?: string | CompactOptions) => Promise<void> = async () => {};
	#getSystemPromptFn: () => string[] = () => [];
	#newSessionHandler: NewSessionHandler = async () => ({ cancelled: false });
	#branchHandler: BranchHandler = async () => ({ cancelled: false });
	#navigateTreeHandler: NavigateTreeHandler = async () => ({ cancelled: false });
	#switchSessionHandler: SwitchSessionHandler = async () => ({ cancelled: false });
	#reloadHandler: () => Promise<void> = async () => {};
	#shutdownHandler: ShutdownHandler = () => {};
	#getMemoryFn?: () => MemoryRuntimeContext | undefined;
	#commandDiagnostics: Array<{ type: string; message: string; path: string }> = [];
	#active = false;
	#deactivated = false;
	#deactivationPromise: Promise<void> | undefined;
	#activationConfig: ExtensionRunnerActivationConfig | undefined;
	#activationPending = false;
	#deactivating = false;
	#sessionStartEmitted = false;
	#generation = 0;
	#shutdownEmitted = false;
	#initialized = false;
	/**
	 * Buffer for `credential_disabled` events received via {@link emitCredentialDisabled}
	 * before {@link initialize} has run. Drained through {@link emit} once initialize sets
	 * up the runtime context, so extension handlers see a populated UI/runtime context
	 * rather than the constructor's no-op default. Bounded at
	 * {@link MAX_PENDING_CREDENTIAL_DISABLED}; oldest entries are dropped under pressure.
	 */
	#pendingCredentialDisabled: CredentialDisabledEvent[] = [];

	/**
	 * Timers scheduled by extensions through the sanctioned `ctx.setInterval` /
	 * `ctx.setTimeout` helpers. Callbacks run with the same isolation as handler
	 * dispatch — a throw is logged and routed through {@link onError} instead of
	 * escaping to the process `uncaughtException` handler and tearing down the
	 * whole session (issue #5664). Handles are `unref`'d and every outstanding
	 * timer is cleared on session teardown via {@link clearManagedTimers}.
	 */
	#managedTimers = new ManagedTimers((event, error, stack) =>
		this.emitError({ extensionPath: "<timer>", event, error, stack }),
	);

	constructor(
		private readonly extensions: Extension[],
		private readonly runtime: ExtensionRuntime,
		private readonly cwd: string,
		private readonly sessionManager: SessionManager,
		private readonly modelRegistry: ModelRegistry,
		getMemory?: () => MemoryRuntimeContext | undefined,
		private readonly settings?: Settings,
		private readonly localProtocolOptions?: LocalProtocolOptions,
	) {
		this.#uiContext = noOpUIContext;
		this.#leasedUiContext = noOpUIContext;
		this.#getMemoryFn = getMemory;
	}

	#bindUIContext(uiContext: ExtensionUIContext): void {
		this.#releaseUIContextLease();
		this.#uiContext = uiContext;
		if (uiContext === noOpUIContext) {
			this.#leasedUiContext = noOpUIContext;
			return;
		}
		const owner = {};
		this.#uiContextLeaseOwner = owner;
		uiContextLeaseOwners.set(uiContext, owner);
		this.#leasedUiContext = createLeasedUIContext(uiContext, owner);
	}

	#releaseUIContextLease(): void {
		const owner = this.#uiContextLeaseOwner;
		if (owner && uiContextLeaseOwners.get(this.#uiContext) === owner) {
			uiContextLeaseOwners.delete(this.#uiContext);
		}
		this.#uiContextLeaseOwner = undefined;
	}

	initialize(
		actions: ExtensionActions,
		contextActions: ExtensionContextActions,
		commandContextActions?: ExtensionCommandContextActions,
		uiContext?: ExtensionUIContext,
	): void {
		// Copy actions into the shared runtime (all extension APIs reference this)
		this.runtime.sendMessage = actions.sendMessage;
		this.runtime.sendUserMessage = actions.sendUserMessage;
		this.runtime.appendEntry = actions.appendEntry;
		this.runtime.setLabel = actions.setLabel;
		this.runtime.getActiveTools = actions.getActiveTools;
		this.runtime.getAllTools = actions.getAllTools;
		this.runtime.setActiveTools = actions.setActiveTools;
		this.runtime.getCommands = actions.getCommands;
		this.runtime.setModel = actions.setModel;
		this.runtime.getThinkingLevel = actions.getThinkingLevel;
		this.runtime.setThinkingLevel = actions.setThinkingLevel;
		this.runtime.getSessionName = actions.getSessionName;
		this.runtime.setSessionName = actions.setSessionName;

		// Context actions (required)
		this.#getModel = contextActions.getModel;
		this.#isIdleFn = contextActions.isIdle;
		this.#abortFn = contextActions.abort;
		this.#hasPendingMessagesFn = contextActions.hasPendingMessages;
		this.#shutdownHandler = contextActions.shutdown;
		this.#getSystemPromptFn = contextActions.getSystemPrompt;

		// Command context actions (optional, only for interactive mode)
		if (commandContextActions) {
			this.#waitForIdleFn = commandContextActions.waitForIdle;
			this.#newSessionHandler = commandContextActions.newSession;
			this.#branchHandler = commandContextActions.branch;
			this.#navigateTreeHandler = commandContextActions.navigateTree;
			this.#switchSessionHandler = commandContextActions.switchSession;
			this.#reloadHandler = commandContextActions.reload;
			this.#getContextUsageFn = commandContextActions.getContextUsage;
			this.#compactFn = commandContextActions.compact;
		} else {
			this.#waitForIdleFn = async () => {};
			this.#newSessionHandler = async () => ({ cancelled: false });
			this.#branchHandler = async () => ({ cancelled: false });
			this.#navigateTreeHandler = async () => ({ cancelled: false });
			this.#switchSessionHandler = async () => ({ cancelled: false });
			this.#reloadHandler = async () => {};
			this.#getContextUsageFn = () => undefined;
			this.#compactFn = async () => {};
		}

		this.#bindUIContext(uiContext ?? noOpUIContext);
		this.#activationConfig = { actions, contextActions, commandContextActions, uiContext };
		this.#initialized = true;

		// Drain events buffered by emitCredentialDisabled() before initialize ran. The
		// spread adds the `type` discriminator — `event` is the pi-ai shape (no `type`).
		// Deferred by one microtask so callers that register an onError listener
		// synchronously after initialize() see handler errors routed through it.
		const pending = this.#pendingCredentialDisabled.splice(0);
		queueMicrotask(() => {
			for (const event of pending) {
				this.emit({ type: "credential_disabled", ...event }).catch((error: unknown) => {
					logger.warn("credential_disabled handler threw during initialize flush", {
						provider: event.provider,
						error: error instanceof Error ? error.message : String(error),
					});
				});
			}
		});
	}

	/**
	 * Configure and mark a logical extension generation active without emitting
	 * `session_start`. Resource transactions use this phase before publication so
	 * admitted work never observes an inactive published runner.
	 */
	async startActivation(
		actions?: ExtensionActions,
		contextActions?: ExtensionContextActions,
		commandContextActions?: ExtensionCommandContextActions,
		uiContext?: ExtensionUIContext,
	): Promise<void> {
		const pendingDeactivation = this.#deactivationPromise;
		if (pendingDeactivation) await pendingDeactivation;

		if (actions !== undefined || contextActions !== undefined) {
			if (!actions || !contextActions) {
				throw new Error("ExtensionRunner.startActivation requires both actions and contextActions");
			}
			this.initialize(actions, contextActions, commandContextActions, uiContext);
		} else if (!this.#initialized) {
			const config = this.#activationConfig;
			if (!config) {
				throw new Error("ExtensionRunner.startActivation requires an initialized runner when actions are omitted");
			}
			this.initialize(config.actions, config.contextActions, config.commandContextActions, config.uiContext);
		}

		const wasActive = this.#active;
		const wasDeactivated = this.#deactivated;
		const startsNewGeneration = !wasActive || wasDeactivated;
		this.#active = true;
		this.#deactivated = false;
		this.#activationPending = false;
		if (startsNewGeneration) {
			this.#generation += 1;
			this.#sessionStartEmitted = false;
			this.#shutdownEmitted = false;
		}
	}

	/** Emit `session_start` once for the active generation. */
	async emitSessionStart(): Promise<void> {
		if (!this.#active || this.#deactivated || this.#sessionStartEmitted) return;
		await this.emit({ type: "session_start" });
	}

	/**
	 * Start a logical extension generation and emit its activation event.
	 *
	 * The positional arguments intentionally mirror {@link initialize}; callers
	 * that still configure the runner through initialize() can activate it with
	 * no arguments.
	 */
	async activate(
		actions?: ExtensionActions,
		contextActions?: ExtensionContextActions,
		commandContextActions?: ExtensionCommandContextActions,
		uiContext?: ExtensionUIContext,
	): Promise<void> {
		await this.startActivation(actions, contextActions, commandContextActions, uiContext);
		await this.emitSessionStart();
	}

	/**
	 * Copy activation capabilities without starting the target generation.
	 * Resource transactions use this split so `session_start` runs only after
	 * publication and its admission gate have fully settled.
	 */
	prepareActivationFrom(previous: ExtensionRunner): void {
		if (this.#active) throw new Error("ExtensionRunner.prepareActivationFrom requires an inactive target runner");
		const config = previous.#activationConfig;
		if (!config) {
			throw new Error("Cannot prepare activation from an uninitialized ExtensionRunner");
		}
		for (const listener of previous.#errorListeners) {
			this.#errorListeners.add(listener);
		}
		this.#activationConfig = config;
		this.#activationPending = previous.#active || previous.#activationPending;
	}

	get canTransferActivation(): boolean {
		return this.#activationConfig !== undefined;
	}

	get hasPendingActivation(): boolean {
		return this.#activationPending;
	}

	/**
	 * Transfer the initialized generation configuration and error observers from
	 * another runner before starting this runner's generation.
	 */
	async activateFrom(previous: ExtensionRunner): Promise<void> {
		this.prepareActivationFrom(previous);
		await this.activate();
	}

	/**
	 * Stop the current logical extension generation. Shutdown is the sole event
	 * permitted through the inactive gate and is emitted before generation-owned
	 * callbacks and error listeners are released.
	 */
	async deactivate(): Promise<void> {
		const pendingDeactivation = this.#deactivationPromise;
		if (pendingDeactivation) {
			await pendingDeactivation;
			return;
		}
		if (!this.#active) {
			if (this.#initialized || this.#activationConfig) {
				this.#deactivated = true;
				this.#resetGenerationCallbacks();
			}
			return;
		}
		if (this.#deactivated) return;

		this.#active = false;
		this.#deactivated = true;
		const deactivation = this.#deactivateGeneration();
		this.#deactivationPromise = deactivation;
		try {
			await deactivation;
		} finally {
			if (this.#deactivationPromise === deactivation) {
				this.#deactivationPromise = undefined;
			}
		}
	}

	get isActive(): boolean {
		return this.#active;
	}
	async #deactivateGeneration(): Promise<void> {
		this.#deactivating = true;
		this.#revokeGenerationActions();
		try {
			if (!this.#shutdownEmitted && this.#sessionStartEmitted) {
				await this.emit({ type: "session_shutdown" });
			}
		} finally {
			this.#managedTimers.clearAll();
			this.#deactivating = false;
			this.#resetGenerationCallbacks();
		}
	}

	#revokeGenerationActions(): void {
		this.#waitForIdleFn = async () => {};
		this.#abortFn = () => {};
		this.#compactFn = async () => {};
		this.#newSessionHandler = async () => ({ cancelled: false });
		this.#branchHandler = async () => ({ cancelled: false });
		this.#navigateTreeHandler = async () => ({ cancelled: false });
		this.#switchSessionHandler = async () => ({ cancelled: false });
		this.#reloadHandler = async () => {};
		this.#shutdownHandler = () => {};
		this.runtime.sendMessage = () => {};
		this.runtime.sendUserMessage = () => {};
		this.runtime.appendEntry = () => {};
		this.runtime.setLabel = () => {};
		this.runtime.setActiveTools = async () => {};
		this.runtime.setModel = async () => false;
		this.runtime.setThinkingLevel = () => {};
		this.runtime.setSessionName = async () => {};
	}

	#resetGenerationCallbacks(): void {
		this.#releaseUIContextLease();
		this.#uiContext = noOpUIContext;
		this.#leasedUiContext = noOpUIContext;
		this.#getModel = () => undefined;
		this.#isIdleFn = () => true;
		this.#waitForIdleFn = async () => {};
		this.#abortFn = () => {};
		this.#hasPendingMessagesFn = () => false;
		this.#getContextUsageFn = () => undefined;
		this.#compactFn = async () => {};
		this.#getSystemPromptFn = () => [];
		this.#newSessionHandler = async () => ({ cancelled: false });
		this.#branchHandler = async () => ({ cancelled: false });
		this.#navigateTreeHandler = async () => ({ cancelled: false });
		this.#switchSessionHandler = async () => ({ cancelled: false });
		this.#reloadHandler = async () => {};
		this.#shutdownHandler = () => {};
		this.runtime.sendMessage = () => {};
		this.runtime.sendUserMessage = () => {};
		this.runtime.appendEntry = () => {};
		this.runtime.setLabel = () => {};
		this.runtime.getActiveTools = () => [];
		this.runtime.getAllTools = () => [];
		this.runtime.setActiveTools = async () => {};
		this.runtime.getCommands = () => [];
		this.runtime.setModel = async () => false;
		this.runtime.getThinkingLevel = () => undefined;
		this.runtime.setThinkingLevel = () => {};
		this.runtime.getSessionName = () => undefined;
		this.runtime.setSessionName = async () => {};
		this.#initialized = false;
		this.#activationConfig = undefined;
		this.#activationPending = false;
		this.#pendingCredentialDisabled = [];
		this.#errorListeners.clear();
	}

	/**
	 * Forward a `credential_disabled` event from `AuthStorage` to extension handlers.
	 *
	 * If {@link initialize} has not yet run, the event is buffered and replayed once
	 * initialize wires the runtime/UI context. This matters because mode controllers
	 * (interactive, RPC, ACP, print, subagent) call `initialize()` AFTER `createAgentSession`
	 * returns, but `AuthStorage` can fire `credential_disabled` during startup model probes
	 * inside `createAgentSession()`. Without deferral, extension handlers would observe
	 * `hasUI=false`, an unset model, and no-op runtime actions on exactly the headline
	 * "OAuth invalid_grant during startup" path the event was designed to surface.
	 *
	 * Always returns; never throws. Errors from handlers are routed through
	 * {@link onError} via {@link emit}'s normal isolation.
	 */
	async emitCredentialDisabled(event: CredentialDisabledEvent): Promise<void> {
		if (this.#deactivated) return;
		if (!this.#initialized) {
			if (this.#pendingCredentialDisabled.length >= MAX_PENDING_CREDENTIAL_DISABLED) {
				this.#pendingCredentialDisabled.shift();
			}
			this.#pendingCredentialDisabled.push(event);
			return;
		}
		await this.emit({ type: "credential_disabled", ...event });
	}

	async emitSessionStop(event: Omit<SessionStopEvent, "type">): Promise<SessionStopEventResult | undefined> {
		return await this.emit({ type: "session_stop", ...event });
	}

	getUIContext(): ExtensionUIContext {
		return this.#uiContext;
	}

	claimUIContext(): void {
		if (this.#uiContextLeaseOwner) {
			uiContextLeaseOwners.set(this.#uiContext, this.#uiContextLeaseOwner);
		}
	}

	hasUI(): boolean {
		return this.#uiContext !== noOpUIContext;
	}

	getExtensionPaths(): string[] {
		return this.extensions.map(e => e.path);
	}

	/** Get all registered tools from all extensions. */
	getAllRegisteredTools(): RegisteredTool[] {
		const tools: RegisteredTool[] = [];
		for (const ext of this.extensions) {
			for (const tool of ext.tools.values()) {
				tools.push(tool);
			}
		}
		return tools;
	}

	/**
	 * Aggregate the registered CLI flags across a set of extensions (last write
	 * wins on name collision). Static so callers that need the flag set before a
	 * runner exists — e.g. the CLI resolving `@file`/flag args before session
	 * creation — share this exact logic instead of duplicating it.
	 */
	static aggregateFlags(extensions: readonly Extension[]): Map<string, ExtensionFlag> {
		const allFlags = new Map<string, ExtensionFlag>();
		for (const ext of extensions) {
			for (const [name, flag] of ext.flags) {
				allFlags.set(name, flag);
			}
		}
		return allFlags;
	}

	getFlags(): Map<string, ExtensionFlag> {
		return ExtensionRunner.aggregateFlags(this.extensions);
	}

	getFlagValues(): Map<string, boolean | string> {
		return new Map(this.runtime.flagValues);
	}

	setFlagValue(name: string, value: boolean | string): void {
		this.runtime.flagValues.set(name, value);
	}

	static readonly #RESERVED_SHORTCUTS: Record<string, true> = {
		"ctrl+c": true,
		"ctrl+d": true,
		"ctrl+z": true,
		"ctrl+k": true,
		"ctrl+p": true,
		"ctrl+l": true,
		"ctrl+o": true,
		"ctrl+t": true,
		"ctrl+g": true,
		"alt+m": true,
		// Default chord for `app.message.followUp` (Windows Terminal can't deliver Ctrl+Enter; #1903).
		"ctrl+q": true,
		"shift+tab": true,
		"shift+ctrl+p": true,
		"alt+enter": true,
		escape: true,
		enter: true,
	};

	getShortcuts(): Map<KeyId, ExtensionShortcut> {
		const allShortcuts = new Map<KeyId, ExtensionShortcut>();
		for (const ext of this.extensions) {
			for (const [key, shortcut] of ext.shortcuts) {
				const normalizedKey = key.toLowerCase() as KeyId;

				if (ExtensionRunner.#RESERVED_SHORTCUTS[normalizedKey]) {
					logger.warn("Extension shortcut conflicts with built-in shortcut", {
						key,
						extensionPath: shortcut.extensionPath,
					});
					continue;
				}

				const existing = allShortcuts.get(normalizedKey);
				if (existing) {
					logger.warn("Extension shortcut conflict", {
						key,
						extensionPath: shortcut.extensionPath,
						existingExtensionPath: existing.extensionPath,
					});
				}
				allShortcuts.set(normalizedKey, shortcut);
			}
		}
		return allShortcuts;
	}

	onError(listener: ExtensionErrorListener): () => void {
		if (this.#deactivated) return () => {};
		this.#errorListeners.add(listener);
		return () => this.#errorListeners.delete(listener);
	}

	emitError(error: ExtensionError): void {
		if (this.#deactivated && !this.#deactivating) return;
		for (const listener of this.#errorListeners) {
			listener(error);
		}
	}

	hasHandlers(eventType: string): boolean {
		if (this.#deactivated) return false;
		for (const ext of this.extensions) {
			const handlers = ext.handlers.get(eventType);
			if (handlers && handlers.length > 0) {
				return true;
			}
		}
		return false;
	}

	getMessageRenderer(customType: string): MessageRenderer | undefined {
		for (const ext of this.extensions) {
			const renderer = ext.messageRenderers.get(customType);
			if (renderer) {
				return renderer;
			}
		}
		return undefined;
	}

	getAssistantThinkingRenderers(): AssistantThinkingRenderer[] {
		return this.extensions.flatMap(ext => ext.assistantThinkingRenderers);
	}

	getRegisteredCommands(reserved?: ReadonlySet<string>): RegisteredCommand[] {
		this.#commandDiagnostics = [];

		const commands = new Map<string, RegisteredCommand>();
		for (const ext of this.extensions) {
			for (const command of ext.commands.values()) {
				if (reserved?.has(command.name)) {
					const message = `Extension command '${command.name}' from ${ext.path} conflicts with built-in commands. Skipping.`;
					this.#commandDiagnostics.push({ type: "warning", message, path: ext.path });
					if (!this.hasUI()) {
						logger.warn(message);
					}
					continue;
				}

				commands.set(command.name, command);
			}
		}
		return [...commands.values()];
	}

	getCommandDiagnostics(): Array<{ type: string; message: string; path: string }> {
		return this.#commandDiagnostics;
	}

	getCommand(name: string): RegisteredCommand | undefined {
		for (let index = this.extensions.length - 1; index >= 0; index -= 1) {
			const command = this.extensions[index]?.commands.get(name);
			if (command) {
				return command;
			}
		}
		return undefined;
	}

	/** Creates an extension context, optionally scoped to a provider request model. */
	createContext(model?: Model): ExtensionContext {
		const runner = this;
		const generation = this.#generation;
		const isCurrentGeneration = () =>
			runner.#generation === generation && (!runner.#deactivated || runner.#deactivating);
		const canMutateGeneration = () =>
			runner.#generation === generation && !runner.#deactivated && !runner.#deactivating;
		const getModel = () => (isCurrentGeneration() ? (model ?? runner.#getModel()) : undefined);
		const canScheduleTimer = () => canMutateGeneration();
		return {
			get ui() {
				return isCurrentGeneration() ? runner.#leasedUiContext : noOpUIContext;
			},
			getContextUsage: () => (isCurrentGeneration() ? runner.#getContextUsageFn() : undefined),
			compact: instructionsOrOptions =>
				canMutateGeneration() ? runner.#compactFn(instructionsOrOptions) : Promise.resolve(),
			get hasUI() {
				return isCurrentGeneration() && runner.#uiContext !== noOpUIContext;
			},
			cwd: this.cwd,
			sessionManager: runner.#createSessionManagerContext(isCurrentGeneration, canMutateGeneration),
			modelRegistry: this.modelRegistry,
			get model() {
				return getModel();
			},
			models: createExtensionModelQuery(this.modelRegistry, this.settings, getModel),
			isIdle: () => (isCurrentGeneration() ? runner.#isIdleFn() : true),
			abort: () => {
				if (canMutateGeneration()) runner.#abortFn();
			},
			hasPendingMessages: () => (isCurrentGeneration() ? runner.#hasPendingMessagesFn() : false),
			shutdown: () => {
				if (canMutateGeneration()) runner.#shutdownHandler();
			},
			getSystemPrompt: () => (isCurrentGeneration() ? runner.#getSystemPromptFn() : []),
			localProtocolOptions: this.localProtocolOptions,
			get memory() {
				return isCurrentGeneration() ? runner.#getMemoryFn?.() : undefined;
			},
			setInterval: (callback, ms, ...args) =>
				canScheduleTimer() ? runner.#managedTimers.setInterval(callback, ms, ...args) : NOOP_TIMER,
			setTimeout: (callback, ms, ...args) =>
				canScheduleTimer() ? runner.#managedTimers.setTimeout(callback, ms, ...args) : NOOP_TIMER,
			clearTimer: timer => runner.#managedTimers.clear(timer),
		};
	}

	#createSessionManagerContext(
		isCurrentGeneration: () => boolean,
		canMutateGeneration: () => boolean,
	): ReadonlySessionManager {
		const target = this.sessionManager;
		return new Proxy(target, {
			get: (object, property, receiver) => {
				const requiresActiveGeneration = MUTATING_SESSION_MANAGER_MEMBERS.has(property);
				const canAccess = () => isCurrentGeneration() && (!requiresActiveGeneration || canMutateGeneration());
				if (!canAccess()) return undefined;
				const value = Reflect.get(object, property, receiver) as unknown;
				if (typeof value !== "function") return value;
				return (...args: unknown[]) => {
					if (!canAccess()) {
						throw new Error("Extension context session manager is no longer active");
					}
					return Reflect.apply(value, target, args);
				};
			},
		}) as ReadonlySessionManager;
	}

	/**
	 * Request a graceful shutdown. Called by extension tools and event handlers.
	 */
	shutdown(): void {
		this.#shutdownHandler();
	}

	/**
	 * Clear every timer scheduled through `ctx.setInterval` / `ctx.setTimeout`.
	 * Called during session teardown so extension background work does not
	 * outlive the session (a self-scheduling interval would otherwise keep
	 * firing against a disposed session).
	 */
	clearManagedTimers(): void {
		this.#managedTimers.clearAll();
	}

	createCommandContext(): ExtensionCommandContext {
		const generation = this.#generation;
		const context = this.createContext();
		const isCurrentGeneration = () => this.#generation === generation && !this.#deactivated && !this.#deactivating;
		return {
			...context,
			get ui() {
				return context.ui;
			},
			get hasUI() {
				return context.hasUI;
			},
			get model() {
				return context.model;
			},
			getContextUsage: () => context.getContextUsage(),
			waitForIdle: () => (isCurrentGeneration() ? this.#waitForIdleFn() : Promise.resolve()),
			newSession: options =>
				isCurrentGeneration() ? this.#newSessionHandler(options) : Promise.resolve({ cancelled: false }),
			branch: entryId =>
				isCurrentGeneration() ? this.#branchHandler(entryId) : Promise.resolve({ cancelled: false }),
			navigateTree: (targetId, options) =>
				isCurrentGeneration()
					? this.#navigateTreeHandler(targetId, options)
					: Promise.resolve({ cancelled: false }),
			switchSession: sessionPath =>
				isCurrentGeneration() ? this.#switchSessionHandler(sessionPath) : Promise.resolve({ cancelled: false }),
			reload: () => {
				if (!isCurrentGeneration()) return Promise.resolve();
				if (!this.#isIdleFn()) {
					return Promise.reject(new Error("Cannot reload session resources while the agent is running"));
				}
				return this.#reloadHandler();
			},
			compact: instructionsOrOptions => context.compact(instructionsOrOptions),
		};
	}
	#isSessionBeforeEvent(event: RunnerEmitEvent): event is SessionBeforeEvent {
		return (
			event.type === "session_before_switch" ||
			event.type === "session_before_branch" ||
			event.type === "session_before_compact" ||
			event.type === "session_before_tree"
		);
	}
	#isSessionShutdownEvent(event: RunnerEmitEvent): event is Extract<RunnerEmitEvent, { type: "session_shutdown" }> {
		return event.type === "session_shutdown";
	}
	async #runHandlerWithTimeout<TEvent extends { type: string }, TResult>(
		handler: (event: TEvent, ctx: ExtensionContext) => Promise<TResult | undefined> | TResult | undefined,
		event: TEvent,
		ctx: ExtensionContext,
		ext: Extension,
		timeoutMs: number,
	): Promise<TResult | undefined> {
		try {
			const handlerResult = await raceHandlerWithTimeout(Promise.resolve(handler(event, ctx)), timeoutMs);
			if (handlerResult === EXTENSION_HANDLER_TIMEOUT) {
				const error = `handler timed out after ${timeoutMs}ms`;
				logger.warn("Extension handler timed out", {
					extensionPath: ext.path,
					event: event.type,
					timeoutMs,
				});
				this.emitError({
					extensionPath: ext.path,
					event: event.type,
					error,
				});
				return undefined;
			}
			return handlerResult as TResult | undefined;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const stack = err instanceof Error ? err.stack : undefined;
			this.emitError({
				extensionPath: ext.path,
				event: event.type,
				error: message,
				stack,
			});
			return undefined;
		}
	}

	async emit<TEvent extends RunnerEmitEvent>(event: TEvent): Promise<RunnerEmitResult<TEvent>> {
		if (this.#deactivated && !(this.#deactivating && event.type === "session_shutdown")) {
			return undefined as RunnerEmitResult<TEvent>;
		}
		if (event.type === "session_start") {
			if (this.#sessionStartEmitted) return undefined as RunnerEmitResult<TEvent>;
			this.#sessionStartEmitted = true;
		}
		if (event.type === "session_shutdown") {
			if (this.#shutdownEmitted) return undefined as RunnerEmitResult<TEvent>;
			this.#shutdownEmitted = true;
		}
		// Defer the per-event context allocation (and the Promise.race/Bun.sleep
		// timeout machinery) to the first matching handler. Streaming sessions emit
		// message_update / tool_execution_* per delta with usually no extension
		// subscribed; building `ctx` for a zero-handler event is pure waste.
		let ctx: ExtensionContext | undefined;
		let result: SessionBeforeEventResult | SessionCompactingResult | SessionStopEventResult | undefined;

		if (this.#isSessionShutdownEvent(event)) {
			const timeoutMs = handlerTimeoutForEvent(event.type);
			const promises: Promise<unknown>[] = [];
			for (const ext of this.extensions) {
				const handlers = ext.handlers.get(event.type);
				if (!handlers || handlers.length === 0) continue;
				ctx ??= this.createContext();
				for (const handler of handlers) {
					promises.push(this.#runHandlerWithTimeout(handler, event, ctx, ext, timeoutMs));
				}
			}
			if (promises.length > 0) await Promise.all(promises);
			return result as RunnerEmitResult<TEvent>;
		}

		if (this.#deactivated) return result as RunnerEmitResult<TEvent>;
		for (const ext of this.extensions) {
			if (this.#deactivated) return result as RunnerEmitResult<TEvent>;
			const handlers = ext.handlers.get(event.type);
			if (!handlers || handlers.length === 0) continue;
			ctx ??= this.createContext();

			for (const handler of handlers) {
				if (this.#deactivated) return result as RunnerEmitResult<TEvent>;
				const handlerResult = await this.#runHandlerWithTimeout(
					handler,
					event,
					ctx,
					ext,
					handlerTimeoutForEvent(event.type),
				);

				if (this.#isSessionBeforeEvent(event) && handlerResult) {
					result = handlerResult as SessionBeforeEventResult;
					if (result.cancel) {
						return result as RunnerEmitResult<TEvent>;
					}
				}

				if (event.type === "session.compacting" && handlerResult) {
					result = handlerResult as SessionCompactingResult;
				}

				if (event.type === "session_stop" && handlerResult) {
					result = handlerResult as SessionStopEventResult;
					const hasContinuationContext =
						(typeof result.additionalContext === "string" && result.additionalContext.length > 0) ||
						(typeof result.reason === "string" && result.reason.length > 0);
					if ((result.continue === true || result.decision === "block") && hasContinuationContext) {
						return result as RunnerEmitResult<TEvent>;
					}
				}
			}
		}

		return result as RunnerEmitResult<TEvent>;
	}

	async emitToolResult(event: ToolResultEvent): Promise<ToolResultEventResult | undefined> {
		if (this.#deactivated) return undefined;
		const ctx = this.createContext();
		const currentEvent: ToolResultEvent = { ...event };
		let modified = false;

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("tool_result");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				const handlerResult = (await this.#runHandlerWithTimeout(
					handler,
					currentEvent,
					ctx,
					ext,
					extensionHandlerTimeoutMs,
				)) as ToolResultEventResult | undefined;
				if (!handlerResult) continue;

				if (handlerResult.content !== undefined) {
					currentEvent.content = handlerResult.content;
					modified = true;
				}
				if (handlerResult.details !== undefined) {
					currentEvent.details = handlerResult.details;
					modified = true;
				}
				if (handlerResult.isError !== undefined) {
					currentEvent.isError = handlerResult.isError;
					modified = true;
				}
			}
		}

		if (!modified) return undefined;

		return {
			content: currentEvent.content,
			details: currentEvent.details,
			isError: currentEvent.isError,
		};
	}

	/**
	 * Emit a `tool_call` event to every subscribed extension before the tool executes.
	 *
	 * Each handler is bounded by `extensionHandlerTimeoutMs` (default 30s). This
	 * matches the timeout policy already applied to `emitToolResult` and every
	 * other handler routed through `#runHandlerWithTimeout`; without it a single
	 * hung extension (unresolved `await`, network call with no timeout) would
	 * park `ExtensionToolWrapper.execute` indefinitely and freeze tool
	 * dispatch — see issue #3948.
	 *
	 * On-timeout policy: **fail-closed** (return `{ block: true }`). This is
	 * symmetric with the existing error path below and safer for a
	 * pre-execution gate — an unresponsive extension MUST NOT be treated as
	 * silent consent to run the tool.
	 */
	async emitToolCall(event: ToolCallEvent): Promise<ToolCallEventResult | undefined> {
		if (this.#deactivated) return undefined;
		const ctx = this.createContext();
		const timeoutMs = extensionHandlerTimeoutMs;
		let result: ToolCallEventResult | undefined;

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("tool_call");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				try {
					const handlerResult = await raceHandlerWithTimeout(Promise.resolve(handler(event, ctx)), timeoutMs);

					if (handlerResult === EXTENSION_HANDLER_TIMEOUT) {
						const error = `handler timed out after ${timeoutMs}ms`;
						logger.warn("Extension handler timed out", {
							extensionPath: ext.path,
							event: "tool_call",
							timeoutMs,
						});
						this.emitError({
							extensionPath: ext.path,
							event: "tool_call",
							error,
						});
						return {
							block: true,
							reason: `Extension ${ext.path} timed out after ${timeoutMs}ms`,
						};
					}

					if (handlerResult) {
						result = handlerResult as ToolCallEventResult;
						if (result.block) {
							return result;
						}
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "tool_call",
						error: message,
						stack,
					});
					return { block: true, reason: `Extension ${ext.path} failed: ${message}` };
				}
			}
		}

		return result;
	}

	async emitUserBash(event: UserBashEvent): Promise<UserBashEventResult | undefined> {
		return this.emitUserEvent<UserBashEventResult>(event, "user_bash");
	}

	async emitUserPython(event: UserPythonEvent): Promise<UserPythonEventResult | undefined> {
		return this.emitUserEvent<UserPythonEventResult>(event, "user_python");
	}

	private async emitUserEvent<R>(
		event: UserBashEvent | UserPythonEvent,
		eventName: "user_bash" | "user_python",
	): Promise<R | undefined> {
		if (this.#deactivated) return undefined;
		const ctx = this.createContext();

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get(eventName);
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				const handlerResult = await this.#runHandlerWithTimeout(
					handler,
					event,
					ctx,
					ext,
					extensionHandlerTimeoutMs,
				);
				if (handlerResult) {
					return handlerResult as R;
				}
			}
		}

		return undefined;
	}

	async emitResourcesDiscover(
		cwd: string,
		reason: ResourcesDiscoverEvent["reason"],
	): Promise<{
		skillPaths: Array<{ path: string; extensionPath: string }>;
		promptPaths: Array<{ path: string; extensionPath: string }>;
		themePaths: Array<{ path: string; extensionPath: string }>;
	}> {
		if (this.#deactivated) return { skillPaths: [], promptPaths: [], themePaths: [] };
		const ctx = this.createContext();
		const skillPaths: Array<{ path: string; extensionPath: string }> = [];
		const promptPaths: Array<{ path: string; extensionPath: string }> = [];
		const themePaths: Array<{ path: string; extensionPath: string }> = [];

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("resources_discover");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				const event: ResourcesDiscoverEvent = { type: "resources_discover", cwd, reason };
				const handlerResult = await this.#runHandlerWithTimeout(
					handler,
					event,
					ctx,
					ext,
					extensionHandlerTimeoutMs,
				);
				const result = handlerResult as ResourcesDiscoverResult | undefined;

				if (result?.skillPaths?.length) {
					skillPaths.push(...result.skillPaths.map(path => ({ path, extensionPath: ext.path })));
				}
				if (result?.promptPaths?.length) {
					promptPaths.push(...result.promptPaths.map(path => ({ path, extensionPath: ext.path })));
				}
				if (result?.themePaths?.length) {
					themePaths.push(...result.themePaths.map(path => ({ path, extensionPath: ext.path })));
				}
			}
		}

		return { skillPaths, promptPaths, themePaths };
	}

	/** Emit input event. Transforms chain, "handled" short-circuits. */
	async emitInput(
		text: string,
		images: ImageContent[] | undefined,
		source: "interactive" | "rpc" | "extension",
	): Promise<InputEventResult> {
		if (this.#deactivated) return {};
		const ctx = this.createContext();
		let currentText = text;
		let currentImages = images;

		for (const ext of this.extensions) {
			for (const handler of ext.handlers.get("input") ?? []) {
				const event: InputEvent = { type: "input", text: currentText, images: currentImages, source };
				const result = (await this.#runHandlerWithTimeout(handler, event, ctx, ext, extensionHandlerTimeoutMs)) as
					| InputEventResult
					| undefined;
				if (result?.handled) return result;
				if (result?.text !== undefined) {
					currentText = result.text;
					currentImages = result.images ?? currentImages;
				}
			}
		}
		return currentText !== text || currentImages !== images ? { text: currentText, images: currentImages } : {};
	}

	async emitContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
		if (this.#deactivated) return messages;
		const ctx = this.createContext();

		// Check if any extensions actually have context handlers before cloning
		let hasContextHandlers = false;
		for (const ext of this.extensions) {
			if (ext.handlers.get("context")?.length) {
				hasContextHandlers = true;
				break;
			}
		}
		if (!hasContextHandlers) return messages;

		let currentMessages: AgentMessage[];
		try {
			currentMessages = structuredClone(messages);
		} catch {
			// Messages may contain non-cloneable objects (e.g. in ToolResultMessage.details
			// or ProviderPayload). Fall back to a shallow array clone — extensions should
			// return new message arrays rather than mutating in place.
			currentMessages = [...messages];
		}

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("context");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				const event: ContextEvent = { type: "context", messages: currentMessages };
				const handlerResult = await this.#runHandlerWithTimeout(
					handler,
					event,
					ctx,
					ext,
					extensionHandlerTimeoutMs,
				);

				if (handlerResult && (handlerResult as ContextEventResult).messages) {
					currentMessages = (handlerResult as ContextEventResult).messages!;
				}
			}
		}

		return currentMessages;
	}

	/** Runs request payload hooks with the model used for that provider request. */
	async emitBeforeProviderRequest(payload: unknown, model?: Model): Promise<BeforeProviderRequestEventResult> {
		if (this.#deactivated) return payload;
		const ctx = this.createContext(model);
		let currentPayload = payload;

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("before_provider_request");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				const event: BeforeProviderRequestEvent = {
					type: "before_provider_request",
					payload: currentPayload,
				};
				const handlerResult = await this.#runHandlerWithTimeout(
					handler,
					event,
					ctx,
					ext,
					extensionHandlerTimeoutMs,
				);
				if (handlerResult !== undefined) {
					currentPayload = handlerResult;
				}
			}
		}

		return currentPayload;
	}

	async emitAfterProviderResponse(response: ProviderResponseMetadata, _model?: Model): Promise<void> {
		if (this.#deactivated) return;
		const ctx = this.createContext();

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("after_provider_response");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				const event: AfterProviderResponseEvent = {
					type: "after_provider_response",
					status: response.status,
					headers: response.headers,
					requestId: response.requestId,
					metadata: response.metadata,
				};
				await this.#runHandlerWithTimeout(handler, event, ctx, ext, extensionHandlerTimeoutMs);
			}
		}
	}

	async emitBeforeAgentStart(
		prompt: string,
		images: ImageContent[] | undefined,
		systemPrompt: string[],
	): Promise<BeforeAgentStartCombinedResult | undefined> {
		if (this.#deactivated) return undefined;
		const ctx = this.createContext();
		const messages: NonNullable<BeforeAgentStartEventResult["message"]>[] = [];
		let currentSystemPrompt = systemPrompt;
		let systemPromptModified = false;

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("before_agent_start");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				const event: BeforeAgentStartEvent = {
					type: "before_agent_start",
					prompt,
					images,
					systemPrompt: currentSystemPrompt,
				};
				const handlerResult = await this.#runHandlerWithTimeout(
					handler,
					event,
					ctx,
					ext,
					extensionHandlerTimeoutMs,
				);

				if (handlerResult) {
					const result = handlerResult as BeforeAgentStartEventResult;
					if (result.message) {
						messages.push(result.message);
					}
					if (result.systemPrompt !== undefined) {
						currentSystemPrompt =
							typeof result.systemPrompt === "string" ? [result.systemPrompt] : result.systemPrompt;
						systemPromptModified = true;
					}
				}
			}
		}

		if (messages.length > 0 || systemPromptModified) {
			return {
				messages: messages.length > 0 ? messages : undefined,
				systemPrompt: systemPromptModified ? currentSystemPrompt : undefined,
			};
		}

		return undefined;
	}
}
