import type { ReloadRequest, ReloadResult } from "./resource-definition";

/** A single FIFO coordinator for reload transactions. */
export class ReloadCoordinator<K extends string, M> {
	#tail: Promise<void> = Promise.resolve();
	#closed = false;

	get closed(): boolean {
		return this.#closed;
	}

	close(): void {
		this.#closed = true;
	}

	open(): void {
		this.#closed = false;
	}

	enqueue(
		request: ReloadRequest<K>,
		transaction: (request: ReloadRequest<K>) => Promise<ReloadResult<M>>,
	): Promise<ReloadResult<M>> {
		if (this.#closed) return Promise.reject(new Error("Reload coordinator is disposed"));
		const run = this.#tail.then(
			() => transaction(request),
			() => transaction(request),
		);
		this.#tail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	async idle(): Promise<void> {
		await this.#tail;
	}
}
