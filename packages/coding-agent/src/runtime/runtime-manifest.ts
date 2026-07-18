import type { ScopeId } from "./resource-scope";

export interface ResourceSnapshot<T> {
	/** Monotonic revision within this resource domain. */
	readonly revision: number;
	/** Stable identity of the desired source inputs used to produce this snapshot. */
	readonly fingerprint: string;
	readonly value: T;
	readonly owners: readonly ScopeId[];
}

export type ResourceSnapshotMap<R extends object> = {
	readonly [K in keyof R]: ResourceSnapshot<R[K]>;
};

export type AppliedRevisionMap<R extends object> = {
	readonly [K in keyof R]: number;
};

export interface RuntimeManifest<R extends object, C, E> {
	/** Monotonic publication ID for the complete aggregate view. */
	readonly id: number;
	/** Persisted desired-state revision observed while this manifest was prepared. */
	readonly desiredRevision: number;
	readonly resources: ResourceSnapshotMap<R>;
	readonly appliedRevisions: AppliedRevisionMap<R>;
	readonly contributions: C;
	readonly effective: E;
	readonly publishedAt: number;
}

export interface RuntimeManifestInput<R extends object, C, E> {
	readonly id: number;
	readonly desiredRevision: number;
	readonly resources: ResourceSnapshotMap<R>;
	readonly contributions: C;
	readonly effective: E;
	readonly publishedAt?: number;
}

/** Publish a shallowly immutable aggregate. Domain adapters own deep snapshot immutability. */
export function createRuntimeManifest<R extends object, C, E>(
	input: RuntimeManifestInput<R, C, E>,
): RuntimeManifest<R, C, E> {
	const resources = Object.freeze({ ...input.resources }) as ResourceSnapshotMap<R>;
	const appliedRevisions = Object.freeze(
		Object.fromEntries(
			Object.entries(resources).map(([key, snapshot]) => [key, (snapshot as ResourceSnapshot<unknown>).revision]),
		),
	) as AppliedRevisionMap<R>;

	return Object.freeze({
		id: input.id,
		desiredRevision: input.desiredRevision,
		resources,
		appliedRevisions,
		contributions: input.contributions,
		effective: input.effective,
		publishedAt: input.publishedAt ?? Date.now(),
	});
}

export type ReconcileState = "current" | "pending" | "applying" | "failed" | "restart-required" | "degraded";

export interface ReconcileStatus {
	readonly domain: string;
	readonly sourceId?: string;
	readonly desiredRevision?: number;
	readonly appliedRevision?: number;
	readonly state: ReconcileState;
	readonly lastError?: string;
}
