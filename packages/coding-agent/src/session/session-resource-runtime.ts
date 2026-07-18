import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Model, ServiceTierByFamily } from "@oh-my-pi/pi-ai";
import type { AdvisorConfig } from "../advisor";
import type { Rule } from "../capability/rule";
import type { ModelRegistry, ProviderConfigInput } from "../config/model-registry";
import type { PromptTemplate } from "../config/prompt-templates";
import type { SkillsSettings } from "../config/settings";
import type { TtsrManager } from "../export/ttsr";
import type { LoadedCustomCommand } from "../extensibility/custom-commands";
import type { ExtensionRunner, ExtensionUIContext, LoadExtensionsResult } from "../extensibility/extensions";
import type { Skill, SkillWarning } from "../extensibility/skills";
import type { FileSlashCommand } from "../extensibility/slash-commands";
import type { MCPManager } from "../mcp";
import { ContributionStore, highestPriorityLatestWins } from "../runtime/contribution-store";
import {
	CLEAN,
	ManagedValueResource,
	type ManagedValueResourceLifecycle,
	type ManagedValueResourceOptions,
} from "../runtime/managed-value-resource";
import type {
	DesiredRuntimeState,
	ReloadDiagnostic,
	ReloadRequest,
	ReloadResult,
	ResourceDefinitionMap,
	ResourceKey,
} from "../runtime/resource-definition";
import { ResourceGraph } from "../runtime/resource-graph";
import type {
	RuntimeAdmission,
	RuntimeCommitSink,
	RuntimeListener,
	RuntimePublication,
} from "../runtime/resource-runtime";
import { ResourceRuntime } from "../runtime/resource-runtime";
import { type ResourceSource, type ScopeId, ScopeManager } from "../runtime/resource-scope";
import {
	createRuntimeManifest,
	type ReconcileStatus,
	type ResourceSnapshot,
	type RuntimeManifest,
} from "../runtime/runtime-manifest";
import type { ConfiguredThinkingLevel } from "../thinking";
import type { XdevRegistry } from "../tools/xdev";
import type { AuthStorage } from "./auth-storage";
import type { SessionContributionState } from "./session-resource-contributions";

export type { SessionContributionMap, SessionContributionState } from "./session-resource-contributions";

export interface SessionContextFile {
	readonly path: string;
	readonly content: string;
	readonly depth?: number;
}

export interface SessionInstructionResources {
	readonly systemPrompt: readonly string[];
	readonly contextFiles: readonly SessionContextFile[];
	readonly rebuildSystemPrompt: SessionSystemPromptBuilder;
	readonly titleSystemPrompt?: string;
}

export type SessionSystemPromptBuilder = (
	toolNames: readonly string[],
	tools: ReadonlyMap<string, AgentTool>,
	resources?: SessionEffectiveResources,
) => Promise<{ readonly systemPrompt: readonly string[] }>;

export interface SessionRuleResources {
	readonly all: readonly Rule[];
	readonly rulebook: readonly Rule[];
	readonly alwaysApply: readonly Rule[];
	readonly ttsrManager: TtsrManager;
}

export interface SessionSkillResources {
	readonly items: readonly Skill[];
	readonly warnings: readonly SkillWarning[];
	readonly reloadable: boolean;
	readonly settings: SkillsSettings;
}

export interface SessionCommandResources {
	readonly promptTemplates: readonly PromptTemplate[];
	readonly slashCommands: readonly FileSlashCommand[];
	readonly customCommands: readonly LoadedCustomCommand[];
}

export interface SessionExtensionLoadResult {
	readonly extensions: readonly LoadExtensionsResult["extensions"][number][];
	readonly errors: readonly Readonly<LoadExtensionsResult["errors"][number]>[];
	readonly runtime: LoadExtensionsResult["runtime"];
}

export interface SessionExtensionResources {
	readonly result: SessionExtensionLoadResult;
	readonly runner: ExtensionRunner;
}

export interface SessionExtensionProviderRegistration {
	readonly name: string;
	readonly config: ProviderConfigInput;
	readonly sourceId: string;
}

export interface SessionProviderResources {
	readonly authStorage: AuthStorage;
	readonly modelRegistry: ModelRegistry;
	readonly model: Model | undefined;
	readonly thinkingLevel: ConfiguredThinkingLevel | undefined;
	readonly serviceTierByFamily: Readonly<ServiceTierByFamily>;
	readonly extensionSourceIds?: readonly string[];
	readonly extensionProviderRegistrations?: readonly SessionExtensionProviderRegistration[];
}

export type SessionMcpResources =
	| {
			readonly ownership: "absent";
			readonly manager: undefined;
			readonly getServerInstructions: undefined;
			readonly disconnectOwnedManager: undefined;
	  }
	| {
			readonly ownership: "borrowed";
			readonly manager: MCPManager;
			readonly getServerInstructions: (() => ReadonlyMap<string, string> | undefined) | undefined;
			readonly disconnectOwnedManager: undefined;
	  }
	| {
			readonly ownership: "owned";
			readonly manager: MCPManager;
			readonly getServerInstructions: (() => ReadonlyMap<string, string> | undefined) | undefined;
			readonly disconnectOwnedManager: () => Promise<void>;
	  };

export interface SessionToolResources {
	readonly registry: ReadonlyMap<string, AgentTool>;
	readonly contributions: SessionContributionState;
	readonly initialNames: readonly string[];
	readonly builtInNames: ReadonlySet<string>;
	readonly requestedNames: ReadonlySet<string> | undefined;
	readonly initialMountedXdevNames: readonly string[];
	readonly xdevRegistry: XdevRegistry | undefined;
	readonly createVibeTools: (() => AgentTool[]) | undefined;
	readonly setActiveNames: (names: Iterable<string>) => void;
}

export interface SessionAgentResources {
	readonly advisorConfigs: readonly AdvisorConfig[];
	readonly advisorTools: readonly AgentTool[];
	readonly advisorWatchdogPrompt: string | undefined;
	readonly advisorContextPrompt: string | undefined;
	readonly advisorSharedInstructions: string | undefined;
}

export interface SessionUiResources {
	/**
	 * UI contexts and the process-global theme/watchers are borrowed capabilities.
	 * Session reconciliation may rebind them, but must never dispose them.
	 */
	readonly ownership: "borrowed";
	readonly hasUI: boolean;
	readonly setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
	/** Rebind tool execution to the UI context carried by this manifest generation. */
	readonly rebindExtensionContext: () => void;
}

class ReadonlyMapSnapshot<K, V> implements ReadonlyMap<K, V> {
	readonly #map: Map<K, V>;

	constructor(entries: ReadonlyMap<K, V>) {
		this.#map = new Map(entries);
		Object.freeze(this);
	}

	get size(): number {
		return this.#map.size;
	}

	get(key: K): V | undefined {
		return this.#map.get(key);
	}

	has(key: K): boolean {
		return this.#map.has(key);
	}

	entries(): MapIterator<[K, V]> {
		return this.#map.entries();
	}

	keys(): MapIterator<K> {
		return this.#map.keys();
	}

	values(): MapIterator<V> {
		return this.#map.values();
	}

	forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
		this.#map.forEach((value, key) => {
			callbackfn.call(thisArg, value, key, this);
		});
	}

	[Symbol.iterator](): MapIterator<[K, V]> {
		return this.entries();
	}

	get [Symbol.toStringTag](): string {
		return "ReadonlyMap";
	}
}

class ReadonlySetSnapshot<T> implements ReadonlySet<T> {
	readonly #set: Set<T>;

	constructor(values: ReadonlySet<T>) {
		this.#set = new Set(values);
		Object.freeze(this);
	}

	get size(): number {
		return this.#set.size;
	}

	has(value: T): boolean {
		return this.#set.has(value);
	}

	entries(): SetIterator<[T, T]> {
		return this.#set.entries();
	}

	keys(): SetIterator<T> {
		return this.#set.keys();
	}

	values(): SetIterator<T> {
		return this.#set.values();
	}

	forEach(callbackfn: (value: T, value2: T, set: ReadonlySet<T>) => void, thisArg?: unknown): void {
		this.#set.forEach(value => {
			callbackfn.call(thisArg, value, value, this);
		});
	}

	[Symbol.iterator](): SetIterator<T> {
		return this.values();
	}

	get [Symbol.toStringTag](): string {
		return "ReadonlySet";
	}
}

function immutableData<T>(value: T, seen: WeakMap<object, object> = new WeakMap()): T {
	if (value === null || typeof value !== "object") return value;
	const objectValue = value as object;
	const existing = seen.get(objectValue);
	if (existing) return existing as T;
	if (Array.isArray(value)) {
		const clone: unknown[] = [];
		seen.set(objectValue, clone);
		for (const item of value as readonly unknown[]) clone.push(immutableData(item, seen));
		return Object.freeze(clone) as T;
	}
	const prototype = Object.getPrototypeOf(objectValue);
	if (prototype !== Object.prototype && prototype !== null) return value;
	const clone = Object.create(prototype) as Record<PropertyKey, unknown>;
	seen.set(objectValue, clone);
	for (const key of Reflect.ownKeys(objectValue)) {
		const descriptor = Object.getOwnPropertyDescriptor(objectValue, key);
		if (!descriptor) continue;
		Object.defineProperty(
			clone,
			key,
			"value" in descriptor
				? { ...descriptor, value: immutableData(descriptor.value as unknown, seen) }
				: descriptor,
		);
	}
	return Object.freeze(clone) as T;
}

function readonlyArray<T>(values: readonly T[]): readonly T[] {
	return Object.freeze([...values]);
}

function readonlyRecord<T extends object>(value: T): Readonly<T> {
	return Object.freeze({ ...value });
}

function readonlyMap<K, V>(value: ReadonlyMap<K, V>): ReadonlyMap<K, V> {
	return new ReadonlyMapSnapshot(value);
}

function readonlySet<T>(value: ReadonlySet<T>): ReadonlySet<T> {
	return new ReadonlySetSnapshot(value);
}

function normalizeMcpResources(value: SessionMcpResources): SessionMcpResources {
	switch (value.ownership) {
		case "absent":
			if (
				value.manager !== undefined ||
				value.getServerInstructions !== undefined ||
				value.disconnectOwnedManager !== undefined
			) {
				throw new Error("Absent MCP resources cannot include a manager or callbacks");
			}
			return Object.freeze({ ...value });
		case "borrowed":
			if (value.manager === undefined || value.disconnectOwnedManager !== undefined) {
				throw new Error("Borrowed MCP resources require a manager and no disconnect callback");
			}
			return Object.freeze({
				...value,
				getServerInstructions: value.getServerInstructions
					? () => {
							const instructions = value.getServerInstructions?.();
							return instructions === undefined ? undefined : readonlyMap(instructions);
						}
					: undefined,
			});
		case "owned":
			if (value.manager === undefined || value.disconnectOwnedManager === undefined) {
				throw new Error("Owned MCP resources require a manager and disconnect callback");
			}
			return Object.freeze({
				...value,
				getServerInstructions: value.getServerInstructions
					? () => {
							const instructions = value.getServerInstructions?.();
							return instructions === undefined ? undefined : readonlyMap(instructions);
						}
					: undefined,
			});
		default:
			throw new Error("Invalid MCP resource ownership");
	}
}

function normalizeResourceValues(values: SessionResourceValues): SessionResourceValues {
	return Object.freeze({
		providers: Object.freeze({
			...values.providers,
			serviceTierByFamily: readonlyRecord(values.providers.serviceTierByFamily),
			extensionSourceIds:
				values.providers.extensionSourceIds === undefined
					? undefined
					: readonlyArray(values.providers.extensionSourceIds),
			extensionProviderRegistrations:
				values.providers.extensionProviderRegistrations === undefined
					? undefined
					: readonlyArray(
							values.providers.extensionProviderRegistrations.map(registration =>
								Object.freeze({
									...registration,
									config: immutableData(registration.config),
								}),
							),
						),
		}),
		rules: immutableData(values.rules),
		skills: immutableData(values.skills),
		extensions: Object.freeze({
			...values.extensions,
			result: Object.freeze({
				...values.extensions.result,
				extensions: readonlyArray(values.extensions.result.extensions),
				errors: immutableData(values.extensions.result.errors),
			}),
		}),
		mcp: normalizeMcpResources(values.mcp),
		tools: Object.freeze({
			...values.tools,
			registry: readonlyMap(values.tools.registry),
			initialNames: readonlyArray(values.tools.initialNames),
			builtInNames: readonlySet(values.tools.builtInNames),
			requestedNames:
				values.tools.requestedNames === undefined ? undefined : readonlySet(values.tools.requestedNames),
			initialMountedXdevNames: readonlyArray(values.tools.initialMountedXdevNames),
		}),
		commands: immutableData(values.commands),
		instructions: Object.freeze({
			...values.instructions,
			systemPrompt: readonlyArray(values.instructions.systemPrompt),
			contextFiles: readonlyArray(values.instructions.contextFiles.map(file => Object.freeze({ ...file }))),
			rebuildSystemPrompt: async (
				toolNames: readonly string[],
				tools: ReadonlyMap<string, AgentTool>,
				resources?: SessionEffectiveResources,
			) => {
				const result = await values.instructions.rebuildSystemPrompt(toolNames, tools, resources);
				return Object.freeze({ ...result, systemPrompt: readonlyArray(result.systemPrompt) });
			},
		}),
		agents: Object.freeze({
			...values.agents,
			advisorConfigs: immutableData(values.agents.advisorConfigs),
			advisorTools: readonlyArray(values.agents.advisorTools),
		}),
		ui: Object.freeze({ ...values.ui }),
	});
}

function normalizeDomainValue<K extends SessionResourceDomain>(
	current: SessionResourceValues,
	domain: K,
	value: SessionResourceValues[K],
): SessionResourceValues[K] {
	return normalizeResourceValues({ ...current, [domain]: value })[domain] as SessionResourceValues[K];
}
export interface SessionResourceValues {
	readonly providers: SessionProviderResources;
	readonly rules: SessionRuleResources;
	readonly skills: SessionSkillResources;
	readonly extensions: SessionExtensionResources;
	readonly mcp: SessionMcpResources;
	readonly tools: SessionToolResources;
	readonly commands: SessionCommandResources;
	readonly instructions: SessionInstructionResources;
	readonly agents: SessionAgentResources;
	readonly ui: SessionUiResources;
}

export type SessionEffectiveResources = SessionResourceValues;
export type SessionResourceManifest = RuntimeManifest<
	SessionResourceValues,
	SessionContributionState,
	SessionEffectiveResources
>;
export type SessionResourceDomain = ResourceKey<SessionResourceValues>;

const SESSION_RESOURCE_DEPENDENCIES = Object.freeze({
	providers: Object.freeze([]),
	rules: Object.freeze([]),
	skills: Object.freeze(["rules"]),
	extensions: Object.freeze(["providers"]),
	mcp: Object.freeze(["providers"]),
	tools: Object.freeze(["providers", "extensions", "mcp"]),
	commands: Object.freeze(["skills", "extensions", "mcp"]),
	instructions: Object.freeze(["rules", "skills", "tools", "mcp"]),
	agents: Object.freeze(["providers", "tools", "instructions"]),
	ui: Object.freeze(["extensions", "mcp", "tools"]),
} satisfies { readonly [K in SessionResourceDomain]: readonly SessionResourceDomain[] });

const SESSION_RESOURCE_GRAPH = new ResourceGraph<SessionResourceDomain>(
	(Object.keys(SESSION_RESOURCE_DEPENDENCIES) as SessionResourceDomain[]).map(key => ({
		key,
		dependencies: SESSION_RESOURCE_DEPENDENCIES[key],
	})),
);

export const SESSION_RESOURCE_DOMAINS: readonly SessionResourceDomain[] = SESSION_RESOURCE_GRAPH.keys;

export function affectedSessionResourceDomains(
	domains: Iterable<SessionResourceDomain>,
): readonly SessionResourceDomain[] {
	return SESSION_RESOURCE_GRAPH.affectedBy(domains);
}

export interface SessionResourceCandidateOptions<T> extends ManagedValueResourceOptions<T> {
	readonly afterPublish?: () => void | Promise<void>;
}

export type SessionResourceCandidates = {
	readonly [K in SessionResourceDomain]?: SessionResourceCandidateOptions<SessionResourceValues[K]>;
};

export interface SessionResourceDiscoveryContext {
	readonly current: SessionResourceManifest;
	readonly domains: readonly SessionResourceDomain[] | undefined;
	readonly signal: AbortSignal;
}

export type SessionResourceDiscover = (
	context: SessionResourceDiscoveryContext,
) => SessionResourceCandidates | Promise<SessionResourceCandidates>;

export type SessionRuntimeAdmission = RuntimeAdmission<
	SessionResourceValues,
	SessionContributionState,
	SessionEffectiveResources
>;
export type SessionResourceReloadResult = ReloadResult<SessionResourceManifest>;

export interface SessionResourceUpdate<K extends SessionResourceDomain> {
	readonly value: SessionResourceValues[K];
	readonly fingerprint?: string;
	readonly lifecycle?: ManagedValueResourceLifecycle<SessionResourceValues[K]>;
}

export type SessionResourceUpdater<K extends SessionResourceDomain> = (
	current: SessionResourceManifest,
) => SessionResourceUpdate<K>;

export type SessionResourceManifestApplication = (
	manifest: SessionResourceManifest,
	affectedDomains: readonly SessionResourceDomain[],
) => Promise<void>;

export type SessionResourceDefinitionOverrides = Partial<
	ResourceDefinitionMap<SessionResourceValues, SessionContributionState, SessionEffectiveResources>
>;

export type SessionResourceLifecycles = {
	readonly [K in SessionResourceDomain]?: ManagedValueResourceLifecycle<SessionResourceValues[K]>;
};
interface CandidateLifecycleLease<T> {
	readonly lifecycle: ManagedValueResourceLifecycle<T>;
	readonly abortUntransferred: (reason: unknown) => Promise<readonly unknown[]>;
}

function leaseCandidateLifecycle<T>(lifecycle: ManagedValueResourceLifecycle<T>): CandidateLifecycleLease<T> {
	let transferred = false;
	let cleaned = false;
	const cleanup = async (reason: unknown, signal: AbortSignal) => {
		if (cleaned) return CLEAN;
		cleaned = true;
		return (await lifecycle.abort?.(reason, signal)) ?? CLEAN;
	};
	const prepare: ManagedValueResourceLifecycle<T>["prepare"] = async context => {
		await lifecycle.prepare?.(context);
		transferred = true;
	};
	return {
		lifecycle: Object.freeze({
			...lifecycle,
			prepare,
			abort: cleanup,
		}),
		abortUntransferred: async reason => {
			if (transferred || cleaned) return [];
			try {
				const result = await cleanup(reason, AbortSignal.timeout(5_000));
				if (result.degraded && result.errors.length === 0) {
					return [new Error("Candidate cleanup reported degraded state")];
				}
				return result.errors;
			} catch (cause) {
				return [cause];
			}
		},
	};
}

interface SessionResourceStaging {
	readonly providers: ManagedValueResource<SessionProviderResources>;
	readonly rules: ManagedValueResource<SessionRuleResources>;
	readonly skills: ManagedValueResource<SessionSkillResources>;
	readonly extensions: ManagedValueResource<SessionExtensionResources>;
	readonly mcp: ManagedValueResource<SessionMcpResources>;
	readonly tools: ManagedValueResource<SessionToolResources>;
	readonly commands: ManagedValueResource<SessionCommandResources>;
	readonly instructions: ManagedValueResource<SessionInstructionResources>;
	readonly agents: ManagedValueResource<SessionAgentResources>;
	readonly ui: ManagedValueResource<SessionUiResources>;
}

export interface CreateSessionResourceControllerOptions {
	readonly values: SessionResourceValues;
	readonly source?: ResourceSource;
	readonly scopes?: ScopeManager;
	readonly desiredRevision?: number;
	readonly sessionScope?: ScopeId;
	readonly discover?: SessionResourceDiscover;
	readonly definitions?: SessionResourceDefinitionOverrides;
	readonly commit?: RuntimeCommitSink<SessionResourceValues, SessionContributionState, SessionEffectiveResources>;
	readonly rollback?: RuntimeCommitSink<SessionResourceValues, SessionContributionState, SessionEffectiveResources>;
	readonly lifecycles?: SessionResourceLifecycles;
}

function initialFingerprint(domain: SessionResourceDomain): string {
	return `startup:${domain}`;
}

function snapshot<T>(value: T, owner: ScopeId, fingerprint: string): ResourceSnapshot<T> {
	return Object.freeze({
		revision: 1,
		fingerprint,
		value,
		owners: Object.freeze([owner]),
	});
}

function createStaging(
	values: SessionResourceValues,
	lifecycles: SessionResourceLifecycles = {},
): SessionResourceStaging {
	return {
		providers: new ManagedValueResource({
			value: values.providers,
			fingerprint: initialFingerprint("providers"),
			lifecycle: lifecycles.providers,
		}),
		rules: new ManagedValueResource({
			value: values.rules,
			fingerprint: initialFingerprint("rules"),
			lifecycle: lifecycles.rules,
		}),
		skills: new ManagedValueResource({
			value: values.skills,
			fingerprint: initialFingerprint("skills"),
			lifecycle: lifecycles.skills,
		}),
		extensions: new ManagedValueResource({
			value: values.extensions,
			fingerprint: initialFingerprint("extensions"),
			lifecycle: lifecycles.extensions,
		}),
		mcp: new ManagedValueResource({
			value: values.mcp,
			fingerprint: initialFingerprint("mcp"),
			lifecycle: lifecycles.mcp,
		}),
		tools: new ManagedValueResource({
			value: values.tools,
			fingerprint: initialFingerprint("tools"),
			lifecycle: lifecycles.tools,
		}),
		commands: new ManagedValueResource({
			value: values.commands,
			fingerprint: initialFingerprint("commands"),
			lifecycle: lifecycles.commands,
		}),
		instructions: new ManagedValueResource({
			value: values.instructions,
			fingerprint: initialFingerprint("instructions"),
			lifecycle: lifecycles.instructions,
		}),
		agents: new ManagedValueResource({
			value: values.agents,
			fingerprint: initialFingerprint("agents"),
			lifecycle: lifecycles.agents,
		}),
		ui: new ManagedValueResource({
			value: values.ui,
			fingerprint: initialFingerprint("ui"),
			lifecycle: lifecycles.ui,
		}),
	};
}

function createDefinitions(
	staging: SessionResourceStaging,
	overrides: SessionResourceDefinitionOverrides = {},
): ResourceDefinitionMap<SessionResourceValues, SessionContributionState, SessionEffectiveResources> {
	return {
		providers: staging.providers.definition<
			SessionResourceValues,
			SessionContributionState,
			SessionEffectiveResources,
			"providers"
		>("providers", SESSION_RESOURCE_DEPENDENCIES.providers),
		rules: staging.rules.definition<
			SessionResourceValues,
			SessionContributionState,
			SessionEffectiveResources,
			"rules"
		>("rules", SESSION_RESOURCE_DEPENDENCIES.rules),
		skills: staging.skills.definition<
			SessionResourceValues,
			SessionContributionState,
			SessionEffectiveResources,
			"skills"
		>("skills", SESSION_RESOURCE_DEPENDENCIES.skills),
		extensions: staging.extensions.definition<
			SessionResourceValues,
			SessionContributionState,
			SessionEffectiveResources,
			"extensions"
		>("extensions", SESSION_RESOURCE_DEPENDENCIES.extensions),
		mcp: staging.mcp.definition<SessionResourceValues, SessionContributionState, SessionEffectiveResources, "mcp">(
			"mcp",
			SESSION_RESOURCE_DEPENDENCIES.mcp,
		),
		tools: staging.tools.definition<
			SessionResourceValues,
			SessionContributionState,
			SessionEffectiveResources,
			"tools"
		>("tools", SESSION_RESOURCE_DEPENDENCIES.tools),
		commands: staging.commands.definition<
			SessionResourceValues,
			SessionContributionState,
			SessionEffectiveResources,
			"commands"
		>("commands", SESSION_RESOURCE_DEPENDENCIES.commands),
		instructions: staging.instructions.definition<
			SessionResourceValues,
			SessionContributionState,
			SessionEffectiveResources,
			"instructions"
		>("instructions", SESSION_RESOURCE_DEPENDENCIES.instructions),
		agents: staging.agents.definition<
			SessionResourceValues,
			SessionContributionState,
			SessionEffectiveResources,
			"agents"
		>("agents", SESSION_RESOURCE_DEPENDENCIES.agents),
		ui: staging.ui.definition<SessionResourceValues, SessionContributionState, SessionEffectiveResources, "ui">(
			"ui",
			SESSION_RESOURCE_DEPENDENCIES.ui,
		),
		...overrides,
	};
}

function assemble(resources: SessionResourceManifest["resources"]): {
	readonly contributions: SessionContributionState;
	readonly effective: SessionEffectiveResources;
} {
	const tools = resources.tools.value;
	if (!resources.tools.owners[0]) throw new Error("Session tool resources require an owner scope");
	const store = ContributionStore.fromSnapshot(tools.contributions, {
		tool: highestPriorityLatestWins(),
	});
	const registry = new Map<string, AgentTool>();
	for (const [name, resolution] of store.resolveAll("tool")) {
		if (resolution.winner?.value) registry.set(name, resolution.winner.value);
	}
	const effective = normalizeResourceValues({
		providers: resources.providers.value,
		rules: resources.rules.value,
		skills: resources.skills.value,
		extensions: resources.extensions.value,
		mcp: resources.mcp.value,
		tools: { ...tools, registry },
		commands: resources.commands.value,
		instructions: resources.instructions.value,
		agents: resources.agents.value,
		ui: resources.ui.value,
	});
	return {
		contributions: store.getSnapshot(),
		effective,
	};
}

export class SessionResourceController {
	readonly scopes: ScopeManager;
	readonly sessionScope: ScopeId;
	readonly #staging: SessionResourceStaging;
	readonly #runtime: ResourceRuntime<SessionResourceValues, SessionContributionState, SessionEffectiveResources>;
	#desiredRevision: number;
	readonly #discover: SessionResourceDiscover | undefined;
	readonly #lifecycles: SessionResourceLifecycles;
	readonly #lifecycle = new AbortController();
	#manifestApplication: SessionResourceManifestApplication | undefined;
	#replaceTail: Promise<void> = Promise.resolve();
	readonly #publicationContext = new AsyncLocalStorage<symbol>();
	readonly #activePublicationTokens = new Set<symbol>();
	#disposed = false;
	#disposePromise: Promise<void> | undefined;

	constructor(options: CreateSessionResourceControllerOptions) {
		this.#desiredRevision = options.desiredRevision ?? 1;
		this.#discover = options.discover;
		const normalizedValues = normalizeResourceValues(options.values);
		this.#lifecycles = Object.freeze({ ...options.lifecycles });
		this.scopes = options.scopes ?? new ScopeManager("session-resource");
		if (options.sessionScope) {
			if (!options.scopes) throw new Error("An existing session resource scope requires its ScopeManager");
			this.scopes.assertLive(options.sessionScope);
			this.sessionScope = options.sessionScope;
		} else {
			this.sessionScope = this.scopes.create({
				source: options.source ?? { kind: "session", id: "session" },
				revision: options.desiredRevision ?? 1,
			}).id;
		}
		this.#staging = createStaging(normalizedValues, options.lifecycles);
		const owners = Object.fromEntries(
			(Object.keys(normalizedValues) as SessionResourceDomain[]).map(domain => [
				domain,
				this.scopes.create({
					parent: this.sessionScope,
					source: { kind: "startup", id: domain },
					revision: 1,
				}).id,
			]),
		) as Record<SessionResourceDomain, ScopeId>;
		const resources: SessionResourceManifest["resources"] = {
			providers: snapshot(normalizedValues.providers, owners.providers, initialFingerprint("providers")),
			rules: snapshot(normalizedValues.rules, owners.rules, initialFingerprint("rules")),
			skills: snapshot(normalizedValues.skills, owners.skills, initialFingerprint("skills")),
			extensions: snapshot(normalizedValues.extensions, owners.extensions, initialFingerprint("extensions")),
			mcp: snapshot(normalizedValues.mcp, owners.mcp, initialFingerprint("mcp")),
			tools: snapshot(normalizedValues.tools, owners.tools, initialFingerprint("tools")),
			commands: snapshot(normalizedValues.commands, owners.commands, initialFingerprint("commands")),
			instructions: snapshot(normalizedValues.instructions, owners.instructions, initialFingerprint("instructions")),
			agents: snapshot(normalizedValues.agents, owners.agents, initialFingerprint("agents")),
			ui: snapshot(normalizedValues.ui, owners.ui, initialFingerprint("ui")),
		};
		const initialAssembly = assemble(resources);
		const initial = createRuntimeManifest({
			id: 1,
			desiredRevision: options.desiredRevision ?? 1,
			resources,
			contributions: initialAssembly.contributions,
			effective: initialAssembly.effective,
		});
		this.#runtime = new ResourceRuntime({
			sessionScope: this.sessionScope,
			scopes: this.scopes,
			definitions: createDefinitions(this.#staging, options.definitions),
			graph: SESSION_RESOURCE_GRAPH,
			initial,
			assembler: {
				assemble: ({ resources: candidateResources }) => assemble(candidateResources),
			},
			source: options.source,
			commit: async context => {
				await this.#manifestApplication?.(context.next, context.affected);
				await options.commit?.(context);
			},
			rollback: async context => {
				await this.#manifestApplication?.(context.next, context.affected);
				await options.rollback?.(context);
			},
		});
	}

	get current(): SessionResourceManifest {
		return this.#runtime.current;
	}

	get status(): ReadonlyMap<SessionResourceDomain, ReconcileStatus> {
		return this.#runtime.status;
	}

	get desiredRevision(): number {
		return this.#desiredRevision;
	}

	bindManifestApplication(application: SessionResourceManifestApplication): void {
		if (this.#disposed) throw new Error("Session resource controller is disposed");
		if (this.#manifestApplication) throw new Error("Session resource manifest application is already bound");
		this.#manifestApplication = application;
	}

	beginDispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#lifecycle.abort(new Error("Session resource controller is disposed"));
	}

	admit(
		signal?: AbortSignal,
	): Promise<RuntimeAdmission<SessionResourceValues, SessionContributionState, SessionEffectiveResources>> {
		if (this.#disposed) return Promise.reject(new Error("Session resource controller is disposed"));
		return this.#runtime.admit(this.#combinedSignal(signal));
	}

	replace<K extends SessionResourceDomain>(
		domain: K,
		value: SessionResourceValues[K],
		fingerprint?: string,
		lifecycle?: ManagedValueResourceLifecycle<SessionResourceValues[K]>,
	): Promise<ReloadResult<SessionResourceManifest>> {
		if (this.#disposed) return Promise.reject(new Error("Session resource controller is disposed"));
		const desiredRevision = ++this.#desiredRevision;
		let normalizedValue: SessionResourceValues[K];
		try {
			normalizedValue = normalizeDomainValue(this.current.effective, domain, value);
		} catch (cause) {
			return Promise.resolve(this.#failedResult(cause, [domain]));
		}
		const candidate = Object.freeze({
			domain,
			value: normalizedValue,
			fingerprint: fingerprint ?? `replace:${domain}:${desiredRevision}`,
			lifecycle,
		});
		return this.#enqueue(async () => {
			if (this.#disposed) throw new Error("Session resource controller is disposed");
			this.#resetStagingToCurrent();
			try {
				const staging = this.#staging[candidate.domain] as unknown as ManagedValueResource<
					SessionResourceValues[K]
				>;
				staging.stage(
					candidate.value,
					candidate.fingerprint,
					candidate.lifecycle ?? this.#lifecycleFor(candidate.domain),
				);
				return await this.#reconcile(desiredRevision, [candidate.domain], this.#lifecycle.signal);
			} catch (cause) {
				return this.#failedResult(cause, [candidate.domain]);
			} finally {
				this.#resetStagingToCurrent();
			}
		});
	}

	update<K extends SessionResourceDomain>(
		domain: K,
		updater: SessionResourceUpdater<K>,
	): Promise<ReloadResult<SessionResourceManifest>> {
		if (this.#disposed) return Promise.reject(new Error("Session resource controller is disposed"));
		const desiredRevision = ++this.#desiredRevision;
		return this.#enqueue(async () => {
			if (this.#disposed) throw new Error("Session resource controller is disposed");
			this.#resetStagingToCurrent();
			try {
				const update = updater(this.current);
				const normalizedValue = normalizeDomainValue(this.current.effective, domain, update.value);
				const staging = this.#staging[domain] as unknown as ManagedValueResource<SessionResourceValues[K]>;
				staging.stage(
					normalizedValue,
					update.fingerprint ?? `update:${domain}:${desiredRevision}`,
					update.lifecycle ?? this.#lifecycleFor(domain),
				);
				return await this.#reconcile(desiredRevision, [domain], this.#lifecycle.signal);
			} catch (cause) {
				return this.#failedResult(cause, [domain]);
			} finally {
				this.#resetStagingToCurrent();
			}
		});
	}

	async reload(
		domains?: readonly SessionResourceDomain[],
		signal?: AbortSignal,
	): Promise<ReloadResult<SessionResourceManifest>> {
		if (this.#disposed) return Promise.reject(new Error("Session resource controller is disposed"));
		const desiredRevision = ++this.#desiredRevision;
		let requestedDomains: readonly SessionResourceDomain[] | undefined;
		try {
			requestedDomains = domains === undefined ? undefined : Object.freeze([...domains]);
		} catch (cause) {
			return Promise.resolve(this.#failedResult(cause));
		}
		return await this.#enqueue(async () => {
			if (this.#disposed) throw new Error("Session resource controller is disposed");
			this.#resetStagingToCurrent();
			const discoverySignal = this.#combinedSignal(signal);
			if (!this.#discover) {
				try {
					return await this.#reconcile(desiredRevision, requestedDomains, discoverySignal);
				} catch (cause) {
					return this.#failedResult(cause, requestedDomains);
				} finally {
					this.#resetStagingToCurrent();
				}
			}
			const aborters: Array<{
				readonly domain: SessionResourceDomain;
				readonly abort: (reason: unknown) => Promise<readonly unknown[]>;
			}> = [];
			let result: ReloadResult<SessionResourceManifest> | undefined;
			let failure: unknown;
			try {
				discoverySignal.throwIfAborted();
				const candidates = await this.#discover({
					current: this.current,
					domains: requestedDomains,
					signal: discoverySignal,
				});
				const entries: Array<{
					readonly domain: SessionResourceDomain;
					readonly value: SessionResourceValues[SessionResourceDomain];
					readonly fingerprint: string;
					readonly lifecycle:
						| ManagedValueResourceLifecycle<SessionResourceValues[SessionResourceDomain]>
						| undefined;
					readonly previous: ResourceSnapshot<SessionResourceValues[SessionResourceDomain]>;
					readonly afterPublish: (() => void | Promise<void>) | undefined;
				}> = [];
				for (const domain of Object.keys(candidates) as SessionResourceDomain[]) {
					const candidate = candidates[domain] as
						| SessionResourceCandidateOptions<SessionResourceValues[SessionResourceDomain]>
						| undefined;
					if (!candidate) continue;
					const candidateLifecycle = candidate.lifecycle
						? leaseCandidateLifecycle(candidate.lifecycle)
						: undefined;
					if (candidateLifecycle) {
						aborters.push({ domain, abort: candidateLifecycle.abortUntransferred });
					}
					entries.push({
						domain,
						value: candidate.value,
						fingerprint: candidate.fingerprint,
						lifecycle: candidateLifecycle?.lifecycle ?? this.#lifecycleFor(domain),
						previous: this.current.resources[domain] as ResourceSnapshot<
							SessionResourceValues[SessionResourceDomain]
						>,
						afterPublish: candidate.afterPublish,
					});
				}
				discoverySignal.throwIfAborted();
				const stagedDomains: SessionResourceDomain[] = [];
				for (const entry of entries) {
					const staging = this.#staging[entry.domain] as unknown as ManagedValueResource<
						SessionResourceValues[SessionResourceDomain]
					>;
					const normalizedValue = normalizeDomainValue(this.current.effective, entry.domain, entry.value);
					staging.stage(normalizedValue, entry.fingerprint, entry.lifecycle);
					stagedDomains.push(entry.domain);
				}
				const reconcileDomains = requestedDomains
					? [...new Set<SessionResourceDomain>([...requestedDomains, ...stagedDomains])]
					: stagedDomains;
				const publication = entries.some(entry => entry.afterPublish)
					? async (
							runtimeResult: ReloadResult<SessionResourceManifest>,
						): Promise<ReloadResult<SessionResourceManifest>> => {
							const publications: Array<{
								readonly domain: SessionResourceDomain;
								readonly resource: ResourceSnapshot<SessionResourceValues[SessionResourceDomain]>;
								readonly run: () => void | Promise<void>;
							}> = [];
							if (runtimeResult.state !== "failed") {
								for (const entry of entries) {
									if (!entry.afterPublish) continue;
									const resource = runtimeResult.manifest.resources[entry.domain] as ResourceSnapshot<
										SessionResourceValues[SessionResourceDomain]
									>;
									if (resource === entry.previous) continue;
									publications.push({
										domain: entry.domain,
										resource,
										run: entry.afterPublish,
									});
								}
							}
							return await this.#runPublications(runtimeResult, publications);
						}
					: undefined;
				result = await this.#reconcile(desiredRevision, reconcileDomains, discoverySignal, publication);
			} catch (cause) {
				failure = cause;
			} finally {
				this.#resetStagingToCurrent();
			}

			const cleanupReason = failure ?? new Error("Discovered resource candidate was not adopted");
			const cleanupDiagnostics = [];
			for (const aborter of [...aborters].reverse()) {
				for (const cause of await aborter.abort(cleanupReason)) {
					cleanupDiagnostics.push({
						severity: "error" as const,
						domain: aborter.domain,
						message: cause instanceof Error ? cause.message : String(cause),
						cause,
					});
				}
			}
			if (failure !== undefined) {
				const failed = this.#failedResult(failure, requestedDomains);
				return cleanupDiagnostics.length === 0
					? failed
					: { ...failed, diagnostics: Object.freeze([...failed.diagnostics, ...cleanupDiagnostics]) };
			}
			if (!result) return this.#failedResult(new Error("Resource reload produced no result"), requestedDomains);
			return cleanupDiagnostics.length === 0
				? result
				: {
						...result,
						state: result.state === "failed" ? ("failed" as const) : ("degraded" as const),
						diagnostics: Object.freeze([...result.diagnostics, ...cleanupDiagnostics]),
					};
		});
	}

	async #runPublications(
		reloadResult: ReloadResult<SessionResourceManifest>,
		publications: readonly {
			readonly domain: SessionResourceDomain;
			readonly resource: ResourceSnapshot<SessionResourceValues[SessionResourceDomain]>;
			readonly run: () => void | Promise<void>;
		}[],
	): Promise<ReloadResult<SessionResourceManifest>> {
		if (publications.length === 0) return reloadResult;
		const token = Symbol("session-resource-publication");
		this.#activePublicationTokens.add(token);
		try {
			return await this.#publicationContext.run(token, async () => {
				const publicationDiagnostics: ReloadDiagnostic[] = [];
				for (const publication of publications) {
					if (this.#disposed || this.current.resources[publication.domain] !== publication.resource) continue;
					try {
						await publication.run();
					} catch (cause) {
						publicationDiagnostics.push({
							severity: "error",
							domain: publication.domain,
							message: cause instanceof Error ? cause.message : String(cause),
							cause,
						});
					}
				}
				if (publicationDiagnostics.length === 0) return reloadResult;
				return {
					...reloadResult,
					state: reloadResult.state === "failed" ? "failed" : "degraded",
					diagnostics: Object.freeze([...reloadResult.diagnostics, ...publicationDiagnostics]),
				};
			});
		} finally {
			this.#activePublicationTokens.delete(token);
		}
	}

	#enqueue(
		operation: () => Promise<ReloadResult<SessionResourceManifest>>,
	): Promise<ReloadResult<SessionResourceManifest>> {
		const publicationToken = this.#publicationContext.getStore();
		if (publicationToken && this.#activePublicationTokens.has(publicationToken)) return operation();
		const run = this.#replaceTail.then(operation);
		this.#replaceTail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	#failedResult(cause: unknown, domains?: readonly SessionResourceDomain[]): ReloadResult<SessionResourceManifest> {
		const message = cause instanceof Error ? cause.message : String(cause);
		const diagnostics =
			domains && domains.length > 0
				? domains.map(domain => ({ severity: "error" as const, domain: String(domain), message, cause }))
				: [{ severity: "error" as const, message, cause }];
		return {
			state: "failed",
			manifest: this.current,
			diagnostics: Object.freeze(diagnostics),
		};
	}

	#reconcile(
		desiredRevision: number,
		domains?: readonly SessionResourceDomain[],
		signal?: AbortSignal,
		publication?: RuntimePublication<SessionResourceValues, SessionContributionState, SessionEffectiveResources>,
	): Promise<ReloadResult<SessionResourceManifest>> {
		const desired: DesiredRuntimeState<SessionResourceDomain> = {
			revision: desiredRevision,
			resources: (domains ?? []).map(domain => ({
				domain,
				source: { kind: "session", id: domain },
				fingerprint: this.#staging[domain].desired.fingerprint,
				enabled: true,
			})),
		};
		const request: ReloadRequest<SessionResourceDomain> = {
			desired,
			intents: [{ kind: "reconcile-config", domains }],
			signal: this.#combinedSignal(signal),
		};
		return this.#runtime.requestReload(request, publication);
	}

	subscribe(
		listener: RuntimeListener<SessionResourceValues, SessionContributionState, SessionEffectiveResources>,
	): () => void {
		return this.#runtime.subscribe(listener);
	}

	dispose(timeoutMs?: number): Promise<void> {
		if (this.#disposePromise) return this.#disposePromise;
		this.beginDispose();
		this.#disposePromise = this.#disposeAfterQueued(timeoutMs);
		return this.#disposePromise;
	}

	async #disposeAfterQueued(timeoutMs: number | undefined): Promise<void> {
		await this.#replaceTail;
		await this.#runtime.dispose(timeoutMs);
	}

	#lifecycleFor<K extends SessionResourceDomain>(
		domain: K,
	): ManagedValueResourceLifecycle<SessionResourceValues[K]> | undefined {
		return this.#lifecycles[domain] as ManagedValueResourceLifecycle<SessionResourceValues[K]> | undefined;
	}

	#resetStagingToCurrent(): void {
		for (const domain of SESSION_RESOURCE_DOMAINS) this.#resetStagedDomain(domain);
	}

	#resetStagedDomain<K extends SessionResourceDomain>(domain: K): void {
		const staging = this.#staging[domain] as unknown as ManagedValueResource<SessionResourceValues[K]>;
		const applied = this.current.resources[domain] as ResourceSnapshot<SessionResourceValues[K]>;
		staging.reset(applied.value, applied.fingerprint);
	}

	#combinedSignal(signal?: AbortSignal): AbortSignal {
		return signal ? AbortSignal.any([signal, this.#lifecycle.signal]) : this.#lifecycle.signal;
	}
}
