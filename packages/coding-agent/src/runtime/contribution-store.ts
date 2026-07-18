import type { ScopeId } from "./resource-scope";

export type ContributionKind<M extends object> = Extract<keyof M, string>;

export type ContributionDiagnosticSeverity = "info" | "warning" | "error";

export interface ContributionDiagnostic {
	readonly code: string;
	readonly message: string;
	readonly severity?: ContributionDiagnosticSeverity;
}

export interface ContributionMetadata {
	readonly owner: ScopeId;
	readonly sourceId: string;
	readonly revision: number;
	readonly key: string;
	readonly priority: number;
	readonly ordinal: number;
	readonly diagnostics: readonly ContributionDiagnostic[];
}

export interface ContributionEntry<T, K extends string = string> extends ContributionMetadata {
	readonly kind: K;
	readonly value: T;
}

export type ContributionInput<T> = {
	readonly key: string;
	readonly owner: ScopeId;
	readonly sourceId: string;
	readonly revision: number;
	readonly priority?: number;
	readonly diagnostics?: readonly ContributionDiagnostic[];
	readonly value: T;
};

export interface ContributionResolution<T> {
	readonly key: string;
	readonly candidates: readonly ContributionEntry<T>[];
	readonly selected: readonly ContributionEntry<T>[];
	readonly winner?: ContributionEntry<T>;
	readonly value?: T;
	readonly values: readonly T[];
	readonly conflicts: readonly ContributionDiagnostic[];
	readonly diagnostics: readonly ContributionDiagnostic[];
}

export type ContributionResolver<T> = (candidates: readonly ContributionEntry<T>[]) => ContributionResolution<T>;

export type ContributionResolverMap<M extends object> = {
	readonly [K in ContributionKind<M>]: ContributionResolver<M[K]>;
};

export type ContributionResolutionPolicy<T> = ContributionResolver<T>;
export type ContributionPolicyMap<M extends object> = ContributionResolverMap<M>;

type AnyEntry<M extends object> = {
	[K in ContributionKind<M>]: ContributionEntry<M[K], K>;
}[ContributionKind<M>];

export type ContributionSnapshotEntries<M extends object> = {
	readonly [K in ContributionKind<M>]: readonly ContributionEntry<M[K], K>[];
};

export interface ContributionSnapshot<M extends object> {
	readonly nextOrdinal: number;
	readonly entries: ContributionSnapshotEntries<M>;
}
function freezeDiagnostics(
	diagnostics: readonly ContributionDiagnostic[] | undefined,
): readonly ContributionDiagnostic[] {
	return Object.freeze((diagnostics ?? []).map(diagnostic => Object.freeze({ ...diagnostic })));
}

function comparePriorityAndOrdinal<T>(a: ContributionEntry<T>, b: ContributionEntry<T>): number {
	return b.priority - a.priority || a.ordinal - b.ordinal;
}

function compareLatestWinner<T>(a: ContributionEntry<T>, b: ContributionEntry<T>): number {
	return b.priority - a.priority || b.ordinal - a.ordinal;
}

function makeResolution<T>(
	candidates: readonly ContributionEntry<T>[],
	selected: readonly ContributionEntry<T>[],
	winner: ContributionEntry<T> | undefined,
	conflicts: readonly ContributionDiagnostic[] = [],
): ContributionResolution<T> {
	const values = selected.map(entry => entry.value);
	const diagnostics = candidates.flatMap(entry => entry.diagnostics);
	return Object.freeze({
		key: candidates[0]?.key ?? "",
		candidates: Object.freeze([...candidates]),
		selected: Object.freeze([...selected]),
		...(winner === undefined ? {} : { winner }),
		...(selected.length === 1 ? { value: values[0] } : {}),
		values: Object.freeze(values),
		conflicts: freezeDiagnostics(conflicts),
		diagnostics: freezeDiagnostics([...diagnostics, ...conflicts]),
	});
}

export function highestPriorityLatestWins<T>(): ContributionResolver<T> {
	return candidates => {
		const winner = [...candidates].sort(compareLatestWinner)[0];
		return makeResolution(candidates, winner === undefined ? [] : [winner], winner);
	};
}

export function orderedCollection<T>(): ContributionResolver<T> {
	return candidates => {
		const selected = [...candidates].sort(comparePriorityAndOrdinal);
		return makeResolution(candidates, selected, undefined);
	};
}

export class ContributionStore<M extends object> {
	readonly #resolvers: ContributionResolverMap<M>;
	readonly #entries = new Map<ContributionKind<M>, Map<string, AnyEntry<M>[]>>();
	#nextOrdinal: number;
	constructor(resolvers: ContributionResolverMap<M>, snapshot?: ContributionSnapshot<M>) {
		this.#resolvers = { ...resolvers };
		this.#nextOrdinal = snapshot?.nextOrdinal ?? 0;
		for (const kind of Object.keys(resolvers) as ContributionKind<M>[]) this.#entries.set(kind, new Map());
		if (snapshot !== undefined) this.#loadSnapshot(snapshot);
	}

	static fromSnapshot<M extends object>(
		snapshot: ContributionSnapshot<M>,
		resolvers: ContributionResolverMap<M>,
	): ContributionStore<M> {
		return new ContributionStore(resolvers, snapshot);
	}

	clone(): ContributionStore<M> {
		return ContributionStore.fromSnapshot(this.getSnapshot(), this.#resolvers);
	}

	add<K extends ContributionKind<M>>(kind: K, contribution: ContributionInput<M[K]>): ContributionEntry<M[K], K> {
		const entry: ContributionEntry<M[K], K> = Object.freeze({
			kind,
			key: contribution.key,
			owner: contribution.owner,
			sourceId: contribution.sourceId,
			revision: contribution.revision,
			priority: contribution.priority ?? 0,
			ordinal: this.#nextOrdinal++,
			diagnostics: freezeDiagnostics(contribution.diagnostics),
			value: contribution.value,
		});
		const byKey = this.#entriesForKind(kind);
		const candidates = byKey.get(entry.key) ?? [];
		const identity = this.#identity(entry);
		const next = [...candidates.filter(candidate => this.#identity(candidate) !== identity), entry];
		byKey.set(entry.key, next);
		return entry;
	}

	list<K extends ContributionKind<M>>(kind: K, key?: string): readonly ContributionEntry<M[K], K>[] {
		const byKey = this.#entriesForKind(kind);
		if (key !== undefined) return this.#freezeEntries(byKey.get(key) ?? []);
		return this.#freezeEntries([...byKey.values()].flat().sort((a, b) => a.ordinal - b.ordinal));
	}

	resolve<K extends ContributionKind<M>>(kind: K, key: string): ContributionResolution<M[K]> | undefined {
		const candidates = this.list(kind, key);
		if (candidates.length === 0) return undefined;
		const raw = this.#resolvers[kind](candidates);
		return Object.freeze({
			...raw,
			key,
			candidates: Object.freeze([...candidates]),
			selected: Object.freeze([...raw.selected]),
			values: Object.freeze([...raw.values]),
			conflicts: freezeDiagnostics(raw.conflicts),
			diagnostics: freezeDiagnostics(raw.diagnostics),
		});
	}

	resolveAll<K extends ContributionKind<M>>(kind: K): ReadonlyMap<string, ContributionResolution<M[K]>> {
		const result = new Map<string, ContributionResolution<M[K]>>();
		for (const [key] of this.#entriesForKind(kind)) {
			const resolution = this.resolve(kind, key);
			if (resolution !== undefined) result.set(key, resolution);
		}
		return new Map(result);
	}

	removeOwner(owner: ScopeId): number {
		let removed = 0;
		for (const byKey of this.#entries.values()) {
			for (const [key, candidates] of byKey) {
				const remaining = candidates.filter(candidate => candidate.owner !== owner);
				removed += candidates.length - remaining.length;
				if (remaining.length === 0) byKey.delete(key);
				else if (remaining.length !== candidates.length) byKey.set(key, remaining);
			}
		}
		return removed;
	}
	removeWhere<K extends ContributionKind<M>>(
		kind: K,
		predicate: (entry: ContributionEntry<M[K], K>) => boolean,
	): number {
		const byKey = this.#entriesForKind(kind);
		let removed = 0;
		for (const [key, candidates] of byKey) {
			const remaining = candidates.filter(candidate => {
				if (!predicate(candidate)) return true;
				removed++;
				return false;
			});
			if (remaining.length === 0) byKey.delete(key);
			else if (remaining.length !== candidates.length) byKey.set(key, remaining);
		}
		return removed;
	}

	getSnapshot(): ContributionSnapshot<M> {
		const entries = {} as { [K in ContributionKind<M>]: readonly ContributionEntry<M[K], K>[] };
		for (const kind of this.#entries.keys()) entries[kind] = this.list(kind);
		return Object.freeze({ nextOrdinal: this.#nextOrdinal, entries: Object.freeze(entries) });
	}

	#identity(entry: AnyEntry<M>): string {
		return `${entry.owner}\u0000${entry.sourceId}\u0000${entry.key}`;
	}

	#entriesForKind<K extends ContributionKind<M>>(kind: K): Map<string, ContributionEntry<M[K], K>[]> {
		const existing = this.#entries.get(kind);
		if (existing !== undefined) {
			return existing as unknown as Map<string, ContributionEntry<M[K], K>[]>;
		}
		const created = new Map<string, ContributionEntry<M[K], K>[]>();
		this.#entries.set(kind, created as unknown as Map<string, AnyEntry<M>[]>);
		return created;
	}

	#freezeEntries<K extends ContributionKind<M>>(
		entries: readonly ContributionEntry<M[K], K>[],
	): readonly ContributionEntry<M[K], K>[] {
		return Object.freeze([...entries].sort((a, b) => a.ordinal - b.ordinal));
	}

	#loadSnapshot(snapshot: ContributionSnapshot<M>): void {
		for (const kind of Object.keys(snapshot.entries) as ContributionKind<M>[]) {
			const entries = snapshot.entries[kind];
			const byKey = this.#entriesForKind(kind);
			for (const sourceEntry of entries) {
				const entry = Object.freeze({
					...sourceEntry,
					diagnostics: freezeDiagnostics(sourceEntry.diagnostics),
				});
				const candidates = byKey.get(entry.key) ?? [];
				byKey.set(entry.key, [...candidates, entry]);
			}
		}
	}
}
