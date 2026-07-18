import type { ResourceSource, ScopeId, ScopeManager } from "./resource-scope";
import type { ResourceSnapshot, ResourceSnapshotMap, RuntimeManifest } from "./runtime-manifest";

export type ResourceKey<R extends object> = Extract<keyof R, string>;

export interface DesiredResourceState<K extends string> {
	readonly domain: K;
	readonly source: ResourceSource;
	readonly fingerprint: string;
	readonly enabled: boolean;
}

export interface DesiredRuntimeState<K extends string> {
	readonly revision: number;
	readonly resources: readonly DesiredResourceState<K>[];
}

export interface ResourceDiscoveryContext<K extends string> {
	readonly desired: DesiredRuntimeState<K>;
	readonly signal: AbortSignal;
}

export interface ResourcePrepareContext<R extends object, C, E, K extends ResourceKey<R>> {
	readonly desired: DesiredRuntimeState<ResourceKey<R>>;
	readonly current: RuntimeManifest<R, C, E>;
	/** Candidate view containing each dependency already prepared in graph order. */
	readonly candidate: ResourceSnapshotMap<R>;
	readonly affected: readonly ResourceKey<R>[];
	readonly candidateScope: ScopeId;
	readonly scopes: ScopeManager;
	readonly signal: AbortSignal;
	readonly previous: ResourceSnapshot<R[K]>;
}

export interface ResourceHandoffContext {
	readonly signal: AbortSignal;
}

export interface ResourceRetirementContext {
	readonly signal: AbortSignal;
	readonly timeoutMs: number;
}

export interface ResourceCleanupResult {
	readonly degraded: boolean;
	readonly errors: readonly unknown[];
}

export interface ActivatedResource<T> {
	/** Reverse pre-publication external activation when a later handoff fails. */
	compensate(reason: unknown, signal: AbortSignal): Promise<ResourceCleanupResult>;
	/** Release the replaced resource after the candidate manifest is authoritative. */
	retire(previous: ResourceSnapshot<T>, context: ResourceRetirementContext): Promise<ResourceCleanupResult>;
}

export interface PreparedResource<T> {
	readonly candidate: ResourceSnapshot<T>;
	/** Perform the domain-specific cutover while new session work is gated. */
	handoff(context: ResourceHandoffContext): Promise<ActivatedResource<T>>;
	/** Release candidate resources when preparation or validation fails before handoff. */
	abort(reason: unknown, signal: AbortSignal): Promise<ResourceCleanupResult>;
}

export interface ResourceDefinition<R extends object, C, E, K extends ResourceKey<R>> {
	readonly key: K;
	readonly dependencies: readonly ResourceKey<R>[];
	fingerprint(context: ResourceDiscoveryContext<ResourceKey<R>>): Promise<string>;
	prepare(context: ResourcePrepareContext<R, C, E, K>): Promise<PreparedResource<R[K]>>;
}

export type ResourceDefinitionMap<R extends object, C, E> = {
	readonly [K in ResourceKey<R>]: ResourceDefinition<R, C, E, K>;
};

export type ReloadIntent<K extends string> =
	| { readonly kind: "disable"; readonly domain: K; readonly sourceId: string }
	| { readonly kind: "enable"; readonly domain: K; readonly sourceId: string }
	| { readonly kind: "refresh-source"; readonly domain: K; readonly sourceId: string }
	| { readonly kind: "reconcile-config"; readonly domains?: readonly K[] };

export interface ReloadRequest<K extends string> {
	readonly desired: DesiredRuntimeState<K>;
	readonly intents: readonly ReloadIntent<K>[];
	readonly signal?: AbortSignal;
}

export interface ReloadDiagnostic {
	readonly severity: "info" | "warning" | "error";
	readonly domain?: string;
	readonly sourceId?: string;
	readonly message: string;
	readonly cause?: unknown;
}

export interface ReloadResult<M> {
	readonly state: "applied" | "unchanged" | "pending" | "failed" | "degraded";
	readonly manifest: M;
	readonly diagnostics: readonly ReloadDiagnostic[];
}
