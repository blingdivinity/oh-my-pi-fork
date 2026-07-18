import type { ScopeId } from "./resource-scope";

export type LeaseTarget =
	| { readonly kind: "manifest"; readonly revision: number }
	| { readonly kind: "scope"; readonly scope: ScopeId };

interface DrainWaiter {
	readonly keys: ReadonlySet<string>;
	readonly resolve: () => void;
	readonly reject: (reason?: unknown) => void;
	readonly signal?: AbortSignal;
	readonly onAbort?: () => void;
}

function leaseTargetKey(target: LeaseTarget): string {
	return target.kind === "manifest" ? `manifest:${target.revision}` : `scope:${target.scope}`;
}

export class RuntimeLease {
	readonly targets: readonly LeaseTarget[];
	#releaseCallback: (() => void) | undefined;

	constructor(targets: readonly LeaseTarget[], releaseCallback: () => void) {
		this.targets = Object.freeze([...targets]);
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

/** Tracks manifest and owner pins used to quiesce a resource transaction safely. */
export class RuntimeLeaseManager {
	readonly #counts = new Map<string, number>();
	readonly #waiters = new Set<DrainWaiter>();

	acquire(target: LeaseTarget | readonly LeaseTarget[]): RuntimeLease {
		const targets = Array.isArray(target) ? target : [target];
		const uniqueTargets = new Map<string, LeaseTarget>();
		for (const item of targets) uniqueTargets.set(leaseTargetKey(item), item);
		for (const key of uniqueTargets.keys()) this.#counts.set(key, (this.#counts.get(key) ?? 0) + 1);

		return new RuntimeLease([...uniqueTargets.values()], () => {
			for (const key of uniqueTargets.keys()) {
				const count = this.#counts.get(key);
				if (count === undefined) continue;
				if (count <= 1) this.#counts.delete(key);
				else this.#counts.set(key, count - 1);
			}
			this.#resolveDrainedWaiters();
		});
	}

	count(target: LeaseTarget): number {
		return this.#counts.get(leaseTargetKey(target)) ?? 0;
	}

	drain(target: LeaseTarget | readonly LeaseTarget[], signal?: AbortSignal): Promise<void> {
		const targets = Array.isArray(target) ? target : [target];
		const keys = new Set(targets.map(leaseTargetKey));
		if ([...keys].every(key => !this.#counts.has(key))) return Promise.resolve();
		if (signal?.aborted) return Promise.reject(signal.reason);

		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const waiter: DrainWaiter = { keys, resolve, reject, signal };
		if (signal) {
			const onAbort = (): void => {
				this.#removeWaiter(waiter);
				reject(signal.reason);
			};
			Object.assign(waiter, { onAbort });
			signal.addEventListener("abort", onAbort, { once: true });
		}
		this.#waiters.add(waiter);
		return promise;
	}

	drainAll(signal?: AbortSignal): Promise<void> {
		const keys = [...this.#counts.keys()];
		if (keys.length === 0) return Promise.resolve();
		if (signal?.aborted) return Promise.reject(signal.reason);

		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const waiter: DrainWaiter = { keys: new Set(keys), resolve, reject, signal };
		if (signal) {
			const onAbort = (): void => {
				this.#removeWaiter(waiter);
				reject(signal.reason);
			};
			Object.assign(waiter, { onAbort });
			signal.addEventListener("abort", onAbort, { once: true });
		}
		this.#waiters.add(waiter);
		return promise;
	}

	#resolveDrainedWaiters(): void {
		for (const waiter of this.#waiters) {
			if ([...waiter.keys].some(key => this.#counts.has(key))) continue;
			this.#removeWaiter(waiter);
			waiter.resolve();
		}
	}

	#removeWaiter(waiter: DrainWaiter): void {
		this.#waiters.delete(waiter);
		if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
	}
}

export class AdmissionPermit {
	#releaseCallback: (() => void) | undefined;

	constructor(releaseCallback: () => void) {
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

/** Prevents new session work from entering while a manifest is being committed. */
export class ReloadAdmissionGate {
	#open = true;
	#activePermits = 0;
	#opened = Promise.withResolvers<void>();
	#drained = Promise.withResolvers<void>();
	#drainedComplete = true;

	get isOpen(): boolean {
		return this.#open;
	}

	get activePermits(): number {
		return this.#activePermits;
	}

	async admit(signal?: AbortSignal): Promise<AdmissionPermit> {
		if (signal?.aborted) throw signal.reason;
		while (!this.#open) {
			if (signal?.aborted) throw signal.reason;
			const opened = this.#opened.promise;
			if (!signal) await opened;
			else {
				const aborted = Promise.withResolvers<never>();
				const onAbort = (): void => aborted.reject(signal.reason);
				signal.addEventListener("abort", onAbort, { once: true });
				try {
					await Promise.race([opened, aborted.promise]);
				} finally {
					signal.removeEventListener("abort", onAbort);
				}
			}
		}

		if (signal?.aborted) throw signal.reason;
		this.#activePermits++;
		return new AdmissionPermit(() => {
			if (this.#activePermits === 0) return;
			this.#activePermits--;
			if (this.#activePermits === 0 && !this.#drainedComplete) {
				this.#drainedComplete = true;
				this.#drained.resolve();
			}
		});
	}

	close(): Promise<void> {
		if (this.#open) {
			this.#open = false;
			this.#opened = Promise.withResolvers<void>();
			if (this.#drainedComplete) {
				this.#drained = Promise.withResolvers<void>();
				this.#drainedComplete = false;
			}
			if (this.#activePermits === 0) {
				this.#drainedComplete = true;
				this.#drained.resolve();
			}
		}
		return this.#drained.promise;
	}

	open(): void {
		if (this.#open) return;
		this.#open = true;
		this.#opened.resolve();
	}
}
