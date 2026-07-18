import type {
	ActivatedResource,
	PreparedResource,
	ResourceCleanupResult,
	ResourceDefinition,
	ResourceHandoffContext,
	ResourceKey,
	ResourcePrepareContext,
	ResourceRetirementContext,
} from "./resource-definition";
import type { ResourceSnapshot } from "./runtime-manifest";

export const CLEAN: ResourceCleanupResult = Object.freeze({
	degraded: false,
	errors: Object.freeze([]),
});

export interface ManagedValueSnapshot<T> {
	readonly value: T;
	readonly fingerprint: string;
}

export interface ManagedValuePrepareContext<T, R extends object, C, E, K extends ResourceKey<R>> {
	readonly candidate: ResourceSnapshot<T>;
	readonly value: T;
	readonly previous: ResourceSnapshot<T>;
	readonly context: ResourcePrepareContext<R, C, E, K>;
}

export interface ManagedValueHandoffContext<T> extends ResourceHandoffContext {
	readonly candidate: ResourceSnapshot<T>;
	readonly previous: ResourceSnapshot<T>;
}

export type ManagedValueCleanup = ResourceCleanupResult | undefined | Promise<ResourceCleanupResult | undefined>;

export interface ManagedValueResourceLifecycle<T> {
	readonly prepare?: <R extends object, C, E, K extends ResourceKey<R>>(
		context: ManagedValuePrepareContext<T, R, C, E, K>,
	) => void | Promise<void>;
	readonly handoff?: (context: ManagedValueHandoffContext<T>) => void | Promise<void>;
	readonly compensate?: (reason: unknown, signal: AbortSignal) => ManagedValueCleanup;
	readonly abort?: (reason: unknown, signal: AbortSignal) => ManagedValueCleanup;
	readonly retire?: (previous: ResourceSnapshot<T>, context: ResourceRetirementContext) => ManagedValueCleanup;
}

export interface ManagedValueResourceOptions<T> extends ManagedValueSnapshot<T> {
	readonly lifecycle?: ManagedValueResourceLifecycle<T>;
}

interface StagedManagedValue<T> extends ManagedValueSnapshot<T> {
	readonly lifecycle: ManagedValueResourceLifecycle<T>;
}

function freezeLifecycle<T>(lifecycle: ManagedValueResourceLifecycle<T> | undefined): ManagedValueResourceLifecycle<T> {
	return Object.freeze(lifecycle ? { ...lifecycle } : {}) as ManagedValueResourceLifecycle<T>;
}

function cleanupResult(result: ResourceCleanupResult | undefined): ResourceCleanupResult {
	return result ?? CLEAN;
}

/** Stages immutable values behind a ResourceDefinition with managed cutover hooks. */
export class ManagedValueResource<T> {
	#desired: StagedManagedValue<T>;
	readonly #defaultLifecycle: ManagedValueResourceLifecycle<T>;

	constructor(initial: ManagedValueResourceOptions<T>) {
		this.#defaultLifecycle = freezeLifecycle(initial.lifecycle);
		this.#desired = Object.freeze({
			value: initial.value,
			fingerprint: initial.fingerprint,
			lifecycle: this.#defaultLifecycle,
		});
	}

	get desired(): ManagedValueSnapshot<T> {
		return Object.freeze({ value: this.#desired.value, fingerprint: this.#desired.fingerprint });
	}

	stage(value: T, fingerprint: string, lifecycle?: ManagedValueResourceLifecycle<T>): void {
		this.#desired = Object.freeze({
			value,
			fingerprint,
			lifecycle: freezeLifecycle(lifecycle ?? this.#desired.lifecycle),
		});
	}

	reset(value: T, fingerprint: string): void {
		this.#desired = Object.freeze({
			value,
			fingerprint,
			lifecycle: this.#defaultLifecycle,
		});
	}

	definition<R extends Record<K, T>, C, E, K extends Extract<keyof R, string>>(
		key: K,
		dependencies: readonly ResourceKey<R>[],
	): ResourceDefinition<R, C, E, K> {
		return {
			key,
			dependencies,
			fingerprint: async () => this.#desired.fingerprint,
			prepare: async context => {
				const desired = this.#desired;
				const candidate: ResourceSnapshot<R[K]> = Object.freeze({
					revision: context.previous.revision + 1,
					fingerprint: desired.fingerprint,
					value: desired.value as unknown as R[K],
					owners: Object.freeze([context.candidateScope]),
				});
				const prepareContext: ManagedValuePrepareContext<T, R, C, E, K> = {
					candidate: candidate as unknown as ResourceSnapshot<T>,
					value: desired.value,
					previous: context.previous as unknown as ResourceSnapshot<T>,
					context,
				};
				try {
					await desired.lifecycle.prepare?.(prepareContext);
				} catch (cause) {
					const cleanupErrors: unknown[] = [];
					try {
						const cleanup = cleanupResult(await desired.lifecycle.abort?.(cause, AbortSignal.timeout(5_000)));
						cleanupErrors.push(...cleanup.errors);
						if (cleanup.degraded && cleanup.errors.length === 0) {
							cleanupErrors.push(new Error("Candidate cleanup reported degraded state"));
						}
					} catch (cleanupError) {
						cleanupErrors.push(cleanupError);
					}
					if (cleanupErrors.length > 0) {
						throw new AggregateError(
							[cause, ...cleanupErrors],
							cause instanceof Error ? cause.message : String(cause),
						);
					}
					throw cause;
				}

				const prepared: PreparedResource<R[K]> = {
					candidate,
					handoff: async ({ signal }) => {
						const handoffContext: ManagedValueHandoffContext<T> = {
							signal,
							candidate: candidate as unknown as ResourceSnapshot<T>,
							previous: context.previous as unknown as ResourceSnapshot<T>,
						};
						await desired.lifecycle.handoff?.(handoffContext);
						const activated: ActivatedResource<R[K]> = {
							compensate: async (reason, cleanupSignal) =>
								cleanupResult(await desired.lifecycle.compensate?.(reason, cleanupSignal)),
							retire: async (previous, retirementContext) =>
								cleanupResult(
									await desired.lifecycle.retire?.(
										previous as unknown as ResourceSnapshot<T>,
										retirementContext,
									),
								),
						};
						return activated;
					},
					abort: async (reason, cleanupSignal) =>
						cleanupResult(await desired.lifecycle.abort?.(reason, cleanupSignal)),
				};
				return prepared;
			},
		};
	}
}
