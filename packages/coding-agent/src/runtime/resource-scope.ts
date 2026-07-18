export type ScopeId = string & { readonly __resourceScope: unique symbol };

export interface ResourceSource {
	readonly id: string;
	readonly kind: string;
	readonly path?: string;
	readonly label?: string;
}

export interface ResourceScope {
	readonly id: ScopeId;
	readonly parent: ScopeId | null;
	readonly source: ResourceSource;
	readonly revision: number;
	readonly revoked: boolean;
	readonly disposed: boolean;
}

export interface CreateResourceScopeOptions {
	readonly parent?: ScopeId;
	readonly source: ResourceSource;
	readonly revision?: number;
}

export type Disposer = (signal: AbortSignal) => void | Promise<void>;

export interface CleanupError {
	readonly scope: ScopeId;
	readonly cause: unknown;
}

export interface CleanupReport {
	readonly scopes: readonly ScopeId[];
	readonly invoked: number;
	readonly errors: readonly CleanupError[];
	readonly timedOut: boolean;
}

const MAX_SCOPE_TOMBSTONES = 256;

interface ScopeRecord {
	readonly id: ScopeId;
	readonly parent: ScopeId | null;
	readonly source: ResourceSource;
	readonly revision: number;
	readonly children: Set<ScopeId>;
	readonly disposers: Disposer[];
	revoked: boolean;
	disposed: boolean;
	pins: number;
	disposePromise?: Promise<CleanupReport>;
}
interface ScopeTombstone {
	readonly snapshot: ResourceScope;
	readonly report: CleanupReport;
}

interface PinWaiter {
	readonly root: ScopeId;
	readonly resolve: () => void;
	readonly reject: (reason?: unknown) => void;
	readonly signal?: AbortSignal;
	readonly onAbort?: () => void;
}

export class ResourceScopeRevokedError extends Error {
	readonly scope: ScopeId;

	constructor(scope: ScopeId) {
		super(`Resource scope is no longer active: ${scope}`);
		this.name = "ResourceScopeRevokedError";
		this.scope = scope;
	}
}

export class ScopePin {
	readonly scope: ScopeId;
	#releaseCallback: (() => void) | undefined;

	constructor(scope: ScopeId, releaseCallback: () => void) {
		this.scope = scope;
		this.#releaseCallback = releaseCallback;
	}

	get released(): boolean {
		return this.#releaseCallback === undefined;
	}

	release(): void {
		const callback = this.#releaseCallback;
		if (!callback) return;
		this.#releaseCallback = undefined;
		callback();
	}

	[Symbol.dispose](): void {
		this.release();
	}
}

/** Owns host-managed registrations and cleanup for one session resource tree. */
export class ScopeManager {
	readonly #idPrefix: string;
	readonly #records = new Map<ScopeId, ScopeRecord>();
	readonly #pinWaiters = new Set<PinWaiter>();
	readonly #tombstones = new Map<ScopeId, ScopeTombstone>();
	#nextId = 1;
	#disposeTail: Promise<void> = Promise.resolve();

	constructor(idPrefix = "resource") {
		this.#idPrefix = idPrefix;
	}

	create(options: CreateResourceScopeOptions): ResourceScope {
		const parent = options.parent ?? null;
		if (parent) this.assertLive(parent);
		const id = `${this.#idPrefix}:${this.#nextId++}` as ScopeId;
		const record: ScopeRecord = {
			id,
			parent,
			source: Object.freeze({ ...options.source }),
			revision: options.revision ?? 0,
			children: new Set(),
			disposers: [],
			revoked: false,
			disposed: false,
			pins: 0,
		};
		this.#records.set(id, record);
		if (parent) this.#getRecord(parent).children.add(id);
		return this.#snapshot(record);
	}

	get(id: ScopeId): ResourceScope | undefined {
		const record = this.#records.get(id);
		return record ? this.#snapshot(record) : this.#tombstones.get(id)?.snapshot;
	}

	childrenOf(id: ScopeId): readonly ResourceScope[] {
		const record = this.#records.get(id);
		if (!record) {
			if (this.#tombstones.has(id)) return Object.freeze([]);
			throw new Error(`Unknown resource scope: ${id}`);
		}
		return Object.freeze([...record.children].map(child => this.#snapshot(this.#getRecord(child))));
	}

	isWithin(scope: ScopeId, ancestor: ScopeId): boolean {
		let current: ScopeId | null = scope;
		while (current) {
			if (current === ancestor) return true;
			const record = this.#records.get(current);
			if (record) {
				current = record.parent;
				continue;
			}
			const tombstone = this.#tombstones.get(current);
			if (!tombstone) throw new Error(`Unknown resource scope: ${current}`);
			current = tombstone.snapshot.parent;
		}
		return false;
	}

	assertLive(id: ScopeId): void {
		const record = this.#records.get(id);
		if (!record) {
			if (this.#tombstones.has(id)) throw new ResourceScopeRevokedError(id);
			throw new Error(`Unknown resource scope: ${id}`);
		}
		if (record.revoked || record.disposed) throw new ResourceScopeRevokedError(id);
	}

	track(id: ScopeId, disposer: Disposer): () => void {
		this.assertLive(id);
		const record = this.#getRecord(id);
		record.disposers.push(disposer);
		let tracked = true;
		return () => {
			if (!tracked || record.disposed) return;
			tracked = false;
			const index = record.disposers.indexOf(disposer);
			if (index >= 0) record.disposers.splice(index, 1);
		};
	}

	revoke(id: ScopeId, recursive = true): readonly ScopeId[] {
		const records = recursive ? this.#subtree(id) : [this.#getRecord(id)];
		for (const record of records) record.revoked = true;
		return Object.freeze(records.map(record => record.id));
	}

	acquire(id: ScopeId): ScopePin {
		this.assertLive(id);
		const record = this.#getRecord(id);
		record.pins++;
		return new ScopePin(id, () => {
			if (record.pins === 0) return;
			record.pins--;
			this.#resolvePinWaiters();
		});
	}

	waitForIdle(id: ScopeId, signal?: AbortSignal): Promise<void> {
		this.#getRecord(id);
		if (this.#subtree(id).every(record => record.pins === 0)) return Promise.resolve();
		if (signal?.aborted) return Promise.reject(signal.reason);

		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const waiter: PinWaiter = { root: id, resolve, reject, signal };
		if (signal) {
			const onAbort = (): void => {
				this.#removePinWaiter(waiter);
				reject(signal.reason);
			};
			Object.assign(waiter, { onAbort });
			signal.addEventListener("abort", onAbort, { once: true });
		}
		this.#pinWaiters.add(waiter);
		return promise;
	}

	dispose(id: ScopeId, deadlineMs = 3_000): Promise<CleanupReport> {
		const tombstone = this.#tombstones.get(id);
		if (tombstone) return Promise.resolve(tombstone.report);
		const root = this.#getRecord(id);
		if (root.disposePromise) return root.disposePromise;
		this.revoke(id, true);
		const completion = Promise.withResolvers<CleanupReport>();
		root.disposePromise = completion.promise;
		const run = async (): Promise<void> => {
			try {
				completion.resolve(await this.#disposeSubtree(id, deadlineMs));
			} catch (error) {
				completion.resolve(
					Object.freeze({
						scopes: Object.freeze([id]),
						invoked: 0,
						errors: Object.freeze([{ scope: id, cause: error }]),
						timedOut: false,
					}),
				);
			}
		};
		this.#disposeTail = this.#disposeTail.then(run, run);
		return completion.promise;
	}

	async #disposeSubtree(id: ScopeId, deadlineMs: number): Promise<CleanupReport> {
		const records = this.#subtreePostorder(id);
		const errors: CleanupError[] = [];
		let invoked = 0;
		let timedOut = false;
		const abortController = new AbortController();
		const deadline = Promise.withResolvers<void>();
		const timeout = Math.max(0, deadlineMs);
		const timer = setTimeout(() => {
			timedOut = true;
			abortController.abort(new DOMException("Resource cleanup deadline exceeded", "TimeoutError"));
			deadline.resolve();
		}, timeout);
		timer.unref?.();

		try {
			await Promise.race([
				this.waitForIdle(id, abortController.signal).catch(error => {
					if (!abortController.signal.aborted) errors.push({ scope: id, cause: error });
				}),
				deadline.promise,
			]);

			for (const record of records) {
				if (record.disposed) continue;
				record.disposed = true;
				for (let index = record.disposers.length - 1; index >= 0; index--) {
					const disposer = record.disposers[index];
					if (!disposer) continue;
					invoked++;
					try {
						const cleanup = Promise.resolve(disposer(abortController.signal)).catch(error => {
							errors.push({ scope: record.id, cause: error });
						});
						await Promise.race([cleanup, deadline.promise]);
					} catch (error) {
						errors.push({ scope: record.id, cause: error });
					}
				}
				record.disposers.length = 0;
			}
		} finally {
			clearTimeout(timer);
		}

		const report = Object.freeze({
			scopes: Object.freeze(records.map(record => record.id)),
			invoked,
			errors: Object.freeze(errors.map(error => Object.freeze({ ...error }))),
			timedOut,
		});
		this.#unlinkDisposed(records, report);
		return report;
	}

	#unlinkDisposed(records: readonly ScopeRecord[], report: CleanupReport): void {
		for (const record of records) {
			if (record.parent) this.#records.get(record.parent)?.children.delete(record.id);
			this.#records.delete(record.id);
			this.#rememberTombstone(record, report);
		}
	}

	#rememberTombstone(record: ScopeRecord, report: CleanupReport): void {
		this.#tombstones.set(record.id, {
			snapshot: this.#snapshot(record),
			report,
		});
		while (this.#tombstones.size > MAX_SCOPE_TOMBSTONES) {
			const oldest = this.#tombstones.keys().next().value as ScopeId | undefined;
			if (!oldest) break;
			this.#tombstones.delete(oldest);
		}
	}

	#subtree(id: ScopeId): ScopeRecord[] {
		const records: ScopeRecord[] = [];
		const visit = (record: ScopeRecord): void => {
			records.push(record);
			for (const child of record.children) visit(this.#getRecord(child));
		};
		visit(this.#getRecord(id));
		return records;
	}

	#subtreePostorder(id: ScopeId): ScopeRecord[] {
		const records: ScopeRecord[] = [];
		const visit = (record: ScopeRecord): void => {
			for (const child of record.children) visit(this.#getRecord(child));
			records.push(record);
		};
		visit(this.#getRecord(id));
		return records;
	}

	#resolvePinWaiters(): void {
		for (const waiter of this.#pinWaiters) {
			if (this.#subtree(waiter.root).some(record => record.pins > 0)) continue;
			this.#removePinWaiter(waiter);
			waiter.resolve();
		}
	}

	#removePinWaiter(waiter: PinWaiter): void {
		this.#pinWaiters.delete(waiter);
		if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
	}

	#getRecord(id: ScopeId): ScopeRecord {
		const record = this.#records.get(id);
		if (!record) throw new Error(`Unknown resource scope: ${id}`);
		return record;
	}

	#snapshot(record: ScopeRecord): ResourceScope {
		return Object.freeze({
			id: record.id,
			parent: record.parent,
			source: record.source,
			revision: record.revision,
			revoked: record.revoked,
			disposed: record.disposed,
		});
	}
}
