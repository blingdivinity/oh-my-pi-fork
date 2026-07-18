import { AsyncLocalStorage } from "node:async_hooks";

import { ReloadCoordinator } from "./reload-coordinator";
import type {
	ActivatedResource,
	DesiredRuntimeState,
	PreparedResource,
	ReloadDiagnostic,
	ReloadIntent,
	ReloadRequest,
	ReloadResult,
	ResourceCleanupResult,
	ResourceDefinitionMap,
	ResourceKey,
} from "./resource-definition";
import { ResourceGraph } from "./resource-graph";
import type { ResourceSource, ScopeId, ScopeManager, ScopePin } from "./resource-scope";
import { AdmissionPermit, ReloadAdmissionGate, type RuntimeLease, RuntimeLeaseManager } from "./runtime-lease";
import {
	createRuntimeManifest,
	type ReconcileStatus,
	type ResourceSnapshot,
	type ResourceSnapshotMap,
	type RuntimeManifest,
} from "./runtime-manifest";

export interface RuntimeAssemblyContext<R extends object, C, E> {
	readonly resources: ResourceSnapshotMap<R>;
	readonly previousContributions: C;
	readonly current: RuntimeManifest<R, C, E>;
	readonly desired: DesiredRuntimeState<ResourceKey<R>>;
	readonly affected: readonly ResourceKey<R>[];
}

export interface RuntimeAssembly<C, E> {
	readonly contributions: C;
	readonly effective: E;
}

export interface RuntimeValidationContext<R extends object, C, E> extends RuntimeAssemblyContext<R, C, E> {
	readonly candidate: RuntimeAssembly<C, E>;
}

export interface RuntimeAssembler<R extends object, C, E> {
	assemble(context: RuntimeAssemblyContext<R, C, E>): RuntimeAssembly<C, E> | Promise<RuntimeAssembly<C, E>>;
}

export type RuntimeValidator<R extends object, C, E> = (
	context: RuntimeValidationContext<R, C, E>,
) => void | Promise<void>;

export interface RuntimeCommitContext<R extends object, C, E> {
	readonly previous: RuntimeManifest<R, C, E>;
	readonly next: RuntimeManifest<R, C, E>;
	readonly affected: readonly ResourceKey<R>[];
}

export type RuntimeCommitSink<R extends object, C, E> = (
	context: RuntimeCommitContext<R, C, E>,
) => void | Promise<void>;

export interface ResourceRuntimeOptions<R extends object, C, E> {
	readonly sessionScope: ScopeId;
	readonly scopes: ScopeManager;
	readonly definitions: ResourceDefinitionMap<R, C, E>;
	readonly graph?: ResourceGraph<ResourceKey<R>>;
	readonly assembler: RuntimeAssembler<R, C, E>;
	readonly validate?: RuntimeValidator<R, C, E>;
	readonly commit?: RuntimeCommitSink<R, C, E>;
	readonly rollback?: RuntimeCommitSink<R, C, E>;
	readonly initial: RuntimeManifest<R, C, E>;
	readonly cleanupTimeoutMs?: number;
	readonly source?: ResourceSource;
}

export interface RuntimeAdmission<R extends object, C, E> {
	readonly manifest: RuntimeManifest<R, C, E>;
	readonly released: boolean;
	pin(scope: ScopeId): ScopePin;
	release(): void;
	[Symbol.dispose](): void;
}

export type RuntimeListener<R extends object, C, E> = (
	result: ReloadResult<RuntimeManifest<R, C, E>>,
) => void | Promise<void>;

export type RuntimePublication<R extends object, C, E> = (
	result: ReloadResult<RuntimeManifest<R, C, E>>,
) => Promise<ReloadResult<RuntimeManifest<R, C, E>>>;

type MutableResourceSnapshotMap<R extends object> = {
	-readonly [K in keyof R]: ResourceSnapshot<R[K]>;
};

interface PreparedEntry<R extends object> {
	readonly key: ResourceKey<R>;
	readonly scope: ScopeId;
	readonly value: PreparedResource<R[ResourceKey<R>]>;
	readonly previous: ResourceSnapshot<R[ResourceKey<R>]>;
}

interface ActivatedEntry<R extends object> {
	readonly key: ResourceKey<R>;
	readonly value: ActivatedResource<R[ResourceKey<R>]>;
	readonly previous: ResourceSnapshot<R[ResourceKey<R>]>;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function diagnostic(
	error: unknown,
	options: { readonly domain?: string; readonly severity?: ReloadDiagnostic["severity"] } = {},
): ReloadDiagnostic {
	return {
		severity: options.severity ?? "error",
		...(options.domain === undefined ? {} : { domain: options.domain }),
		message: errorMessage(error),
		cause: error,
	};
}

class RuntimeAdmissionHandle<R extends object, C, E> implements RuntimeAdmission<R, C, E> {
	readonly manifest: RuntimeManifest<R, C, E>;
	readonly #scopes: ScopeManager;
	readonly #permit: AdmissionPermit;
	readonly #lease: RuntimeLease;
	readonly #pins: ScopePin[] = [];
	#released = false;

	constructor(manifest: RuntimeManifest<R, C, E>, scopes: ScopeManager, permit: AdmissionPermit, lease: RuntimeLease) {
		this.manifest = manifest;
		this.#scopes = scopes;
		this.#permit = permit;
		this.#lease = lease;
	}

	get released(): boolean {
		return this.#released;
	}

	pin(scope: ScopeId): ScopePin {
		if (this.#released) throw new Error("Runtime admission is already released");
		const pin = this.#scopes.acquire(scope);
		this.#pins.push(pin);
		return pin;
	}

	release(): void {
		if (this.#released) return;
		this.#released = true;
		for (const pin of this.#pins.reverse()) pin.release();
		this.#lease.release();
		this.#permit.release();
	}

	[Symbol.dispose](): void {
		this.release();
	}
}

export class ResourceRuntime<R extends object, C, E> {
	readonly #options: ResourceRuntimeOptions<R, C, E>;
	readonly #graph: ResourceGraph<ResourceKey<R>>;
	readonly #gate = new ReloadAdmissionGate();
	readonly #leases = new RuntimeLeaseManager();
	readonly #coordinator = new ReloadCoordinator<ResourceKey<R>, RuntimeManifest<R, C, E>>();
	readonly #listeners = new Set<RuntimeListener<R, C, E>>();
	readonly #status = new Map<ResourceKey<R>, ReconcileStatus>();
	readonly #lifecycle = new AbortController();
	#current: RuntimeManifest<R, C, E>;
	#disposed = false;
	#disposePromise: Promise<void> | undefined;
	#poisoned: Error | undefined;
	readonly #publicationContext = new AsyncLocalStorage<symbol>();
	readonly #activePublicationTokens = new Set<symbol>();
	#gateHolders = 0;

	constructor(options: ResourceRuntimeOptions<R, C, E>) {
		this.#options = options;
		this.#current = options.initial;
		this.#graph =
			options.graph ??
			new ResourceGraph(
				(Object.keys(options.definitions) as ResourceKey<R>[]).map(key => ({
					key,
					dependencies: options.definitions[key].dependencies,
				})),
			);
		this.#validateInitialOwners();
	}

	get current(): RuntimeManifest<R, C, E> {
		return this.#current;
	}

	get status(): ReadonlyMap<ResourceKey<R>, ReconcileStatus> {
		return new Map([...this.#status].map(([key, status]) => [key, Object.freeze({ ...status })]));
	}

	subscribe(listener: RuntimeListener<R, C, E>): () => void {
		if (this.#disposed) return () => undefined;
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	async admit(signal?: AbortSignal): Promise<RuntimeAdmission<R, C, E>> {
		this.#assertUsable();
		const publicationToken = this.#publicationContext.getStore();
		if (publicationToken && this.#activePublicationTokens.has(publicationToken)) {
			if (signal?.aborted) throw signal.reason;
			const manifest = this.#current;
			const lease = this.#leases.acquire({ kind: "manifest", revision: manifest.id });
			const admission = new RuntimeAdmissionHandle(
				manifest,
				this.#options.scopes,
				new AdmissionPermit(() => undefined),
				lease,
			);
			return admission;
		}
		const admissionSignal = signal ? AbortSignal.any([signal, this.#lifecycle.signal]) : this.#lifecycle.signal;
		const permit = await this.#gate.admit(admissionSignal);
		try {
			this.#assertUsable();
			const manifest = this.#current;
			const lease = this.#leases.acquire({ kind: "manifest", revision: manifest.id });
			return new RuntimeAdmissionHandle(manifest, this.#options.scopes, permit, lease);
		} catch (error) {
			permit.release();
			throw error;
		}
	}

	requestReload(
		request: ReloadRequest<ResourceKey<R>>,
		publication?: RuntimePublication<R, C, E>,
	): Promise<ReloadResult<RuntimeManifest<R, C, E>>> {
		try {
			this.#assertUsable();
		} catch (error) {
			return Promise.reject(error);
		}
		const publicationToken = this.#publicationContext.getStore();
		if (publicationToken && this.#activePublicationTokens.has(publicationToken)) {
			return this.#reload(request, publication);
		}
		return this.#coordinator.enqueue(request, currentRequest => this.#reload(currentRequest, publication));
	}

	dispose(timeoutMs = this.#cleanupTimeoutMs): Promise<void> {
		if (this.#disposePromise) return this.#disposePromise;
		this.#disposed = true;
		this.#lifecycle.abort(new Error("Resource runtime is disposed"));
		this.#coordinator.close();
		this.#disposePromise = this.#disposeSession(timeoutMs);
		return this.#disposePromise;
	}

	get #cleanupTimeoutMs(): number {
		return this.#options.cleanupTimeoutMs ?? 5_000;
	}

	async #disposeSession(timeoutMs: number): Promise<void> {
		await this.#gate.close();
		await this.#coordinator.idle();
		await this.#leases.drainAll();
		try {
			const report = await this.#options.scopes.dispose(this.#options.sessionScope, timeoutMs);
			if (report.timedOut || report.errors.length > 0) {
				const causes: unknown[] = report.errors.map(error => error.cause);
				if (report.timedOut) causes.push(new Error("Resource cleanup deadline exceeded"));
				throw new AggregateError(causes, "Resource runtime disposal did not complete cleanly");
			}
		} finally {
			this.#listeners.clear();
		}
	}

	async #reload(
		request: ReloadRequest<ResourceKey<R>>,
		publication?: RuntimePublication<R, C, E>,
	): Promise<ReloadResult<RuntimeManifest<R, C, E>>> {
		this.#assertUsable();
		const previous = this.#current;
		const signal = request.signal
			? AbortSignal.any([request.signal, this.#lifecycle.signal])
			: this.#lifecycle.signal;
		const diagnostics: ReloadDiagnostic[] = [];
		const prepared: PreparedEntry<R>[] = [];
		const activated: ActivatedEntry<R>[] = [];
		const candidateScopes: ScopeId[] = [];
		const candidateResources = { ...previous.resources } as MutableResourceSnapshotMap<R>;
		let attempted: readonly ResourceKey<R>[] = [];
		let affected: readonly ResourceKey<R>[] = [];
		let gateClosed = false;
		let commitCandidate: RuntimeManifest<R, C, E> | undefined;

		try {
			const explicit = this.#explicitDomains(request.intents);
			const reconciled = this.#reconcileDomains(request.intents);
			attempted = this.#graph.order(new Set([...explicit, ...reconciled]));

			if (signal.aborted) throw signal.reason;
			const discovered = await this.#discover(request.desired, signal, reconciled, previous);
			affected = this.#graph.affectedBy(new Set([...explicit, ...discovered]));
			attempted = affected.length === 0 ? attempted : affected;
			if (affected.length === 0) {
				await this.#gate.close();
				gateClosed = true;
				this.#gateHolders++;
				await this.#leases.drain({ kind: "manifest", revision: previous.id }, signal);
				const unchanged = await this.#publishUnchanged(previous, request, attempted, diagnostics, signal);
				if (gateClosed) {
					this.#gateHolders--;
					if (this.#gateHolders === 0 && !this.#disposed && !this.#poisoned) this.#gate.open();
				}
				return unchanged;
			}

			for (const key of affected) {
				this.#status.set(key, {
					domain: key,
					desiredRevision: request.desired.revision,
					appliedRevision: previous.resources[key].revision,
					state: "applying",
				});
			}

			for (const key of affected) {
				const candidateScope = this.#options.scopes.create({
					parent: this.#options.sessionScope,
					source: this.#candidateSource(key, request.desired.revision),
					revision: request.desired.revision,
				}).id;
				candidateScopes.push(candidateScope);
				const value = await this.#options.definitions[key].prepare({
					desired: request.desired,
					current: previous,
					candidate: candidateResources,
					affected,
					candidateScope,
					scopes: this.#options.scopes,
					signal,
					previous: previous.resources[key],
				});
				prepared.push({ key, scope: candidateScope, value, previous: previous.resources[key] });
				this.#validateCandidateOwners(key, value.candidate, candidateScope);
				candidateResources[key] = value.candidate;
			}

			const assemblyContext: RuntimeAssemblyContext<R, C, E> = {
				resources: candidateResources,
				previousContributions: previous.contributions,
				current: previous,
				desired: request.desired,
				affected,
			};
			const candidate = await this.#options.assembler.assemble(assemblyContext);
			await this.#options.validate?.({ ...assemblyContext, candidate });
			if (signal.aborted) throw signal.reason;

			await this.#gate.close();
			gateClosed = true;
			this.#gateHolders++;
			await this.#leases.drain({ kind: "manifest", revision: previous.id }, signal);
			await this.#waitForOwners(previous, affected, signal);

			for (const item of prepared) {
				signal.throwIfAborted();
				const value = await item.value.handoff({ signal });
				activated.push({ key: item.key, value, previous: item.previous });
				signal.throwIfAborted();
			}

			const next = createRuntimeManifest<R, C, E>({
				id: previous.id + 1,
				desiredRevision: request.desired.revision,
				resources: candidateResources,
				contributions: candidate.contributions,
				effective: candidate.effective,
			});
			commitCandidate = next;
			await this.#options.commit?.({ previous, next, affected });
			signal.throwIfAborted();
			this.#current = next;
		} catch (error) {
			await this.#rollback(prepared, activated, candidateScopes, error, diagnostics);
			if (commitCandidate) {
				try {
					await this.#options.rollback?.({ previous: commitCandidate, next: previous, affected });
				} catch (rollbackError) {
					diagnostics.push(diagnostic(rollbackError));
					this.#poison(rollbackError);
				}
			}
			for (const key of attempted) {
				this.#status.set(key, {
					domain: key,
					desiredRevision: request.desired.revision,
					appliedRevision: previous.resources[key].revision,
					state: "failed",
					lastError: errorMessage(error),
				});
			}
			diagnostics.push(diagnostic(error));
			const result: ReloadResult<RuntimeManifest<R, C, E>> = {
				state: "failed",
				manifest: previous,
				diagnostics: Object.freeze([...diagnostics]),
			};
			await this.#notify(result, diagnostics);
			if (gateClosed) {
				this.#gateHolders--;
				if (this.#gateHolders === 0 && !this.#disposed && !this.#poisoned) this.#gate.open();
			}
			return diagnostics.length === result.diagnostics.length
				? result
				: { ...result, diagnostics: Object.freeze([...diagnostics]) };
		}

		const next = this.#current;
		for (const key of affected) {
			this.#status.set(key, {
				domain: key,
				desiredRevision: request.desired.revision,
				appliedRevision: next.resources[key].revision,
				state: "current",
			});
			diagnostics.push({
				severity: "info",
				domain: key,
				message: `Applied desired revision ${request.desired.revision} as resource revision ${next.resources[key].revision}`,
			});
		}

		const degraded = await this.#retire(activated, previous, next, diagnostics);
		if (degraded) {
			for (const key of affected) {
				const current = this.#status.get(key);
				if (current) this.#status.set(key, { ...current, state: "degraded" });
			}
		}

		const result: ReloadResult<RuntimeManifest<R, C, E>> = {
			state: degraded ? "degraded" : "applied",
			manifest: next,
			diagnostics: Object.freeze([...diagnostics]),
		};
		const published = await this.#runPublication(result, publication, diagnostics);
		const listenerDiagnosticsStart = diagnostics.length;
		await this.#notify(published, diagnostics);
		if (gateClosed) {
			this.#gateHolders--;
			if (this.#gateHolders === 0 && !this.#disposed && !this.#poisoned) this.#gate.open();
		}
		return diagnostics.length === listenerDiagnosticsStart
			? published
			: {
					...published,
					diagnostics: Object.freeze([...published.diagnostics, ...diagnostics.slice(listenerDiagnosticsStart)]),
				};
	}

	async #runPublication(
		result: ReloadResult<RuntimeManifest<R, C, E>>,
		publication: RuntimePublication<R, C, E> | undefined,
		diagnostics: ReloadDiagnostic[],
	): Promise<ReloadResult<RuntimeManifest<R, C, E>>> {
		if (!publication) return result;
		const token = Symbol("runtime-publication");
		this.#activePublicationTokens.add(token);
		try {
			return await this.#publicationContext.run(token, () => publication(result));
		} catch (cause) {
			const failure = diagnostic(cause);
			diagnostics.push(failure);
			return {
				...result,
				state: result.state === "failed" ? "failed" : "degraded",
				diagnostics: Object.freeze([...result.diagnostics, failure]),
			};
		} finally {
			this.#activePublicationTokens.delete(token);
		}
	}

	async #publishUnchanged(
		previous: RuntimeManifest<R, C, E>,
		request: ReloadRequest<ResourceKey<R>>,
		domains: readonly ResourceKey<R>[],
		diagnostics: ReloadDiagnostic[],
		signal: AbortSignal,
	): Promise<ReloadResult<RuntimeManifest<R, C, E>>> {
		const next =
			request.desired.revision === previous.desiredRevision
				? previous
				: createRuntimeManifest({
						id: previous.id + 1,
						desiredRevision: request.desired.revision,
						resources: previous.resources,
						contributions: previous.contributions,
						effective: previous.effective,
					});
		signal.throwIfAborted();
		if (next !== previous) {
			try {
				await this.#options.commit?.({ previous, next, affected: [] });
				signal.throwIfAborted();
			} catch (error) {
				try {
					await this.#options.rollback?.({ previous: next, next: previous, affected: [] });
				} catch (rollbackError) {
					diagnostics.push(diagnostic(rollbackError));
					this.#poison(rollbackError);
				}
				throw error;
			}
			this.#current = next;
		}
		for (const key of domains) {
			this.#status.set(key, {
				domain: key,
				desiredRevision: request.desired.revision,
				appliedRevision: next.resources[key].revision,
				state: "current",
			});
		}
		diagnostics.push({ severity: "info", message: "Desired state is already applied" });
		const result: ReloadResult<RuntimeManifest<R, C, E>> = {
			state: "unchanged",
			manifest: next,
			diagnostics: Object.freeze([...diagnostics]),
		};
		await this.#notify(result, diagnostics);
		return diagnostics.length === result.diagnostics.length
			? result
			: { ...result, diagnostics: Object.freeze([...diagnostics]) };
	}

	async #rollback(
		prepared: readonly PreparedEntry<R>[],
		activated: readonly ActivatedEntry<R>[],
		candidateScopes: readonly ScopeId[],
		reason: unknown,
		diagnostics: ReloadDiagnostic[],
	): Promise<void> {
		const cleanupSignal = AbortSignal.timeout(this.#cleanupTimeoutMs);
		const activatedKeys = new Set(activated.map(item => item.key));
		for (const item of [...prepared].reverse()) {
			if (activatedKeys.has(item.key)) continue;
			try {
				this.#recordCleanup(
					await this.#awaitCleanup(item.value.abort(reason, cleanupSignal), cleanupSignal),
					item.key,
					diagnostics,
				);
			} catch (error) {
				diagnostics.push(diagnostic(error, { domain: item.key }));
			}
		}
		for (const item of [...activated].reverse()) {
			try {
				this.#recordCleanup(
					await this.#awaitCleanup(item.value.compensate(reason, cleanupSignal), cleanupSignal),
					item.key,
					diagnostics,
				);
			} catch (error) {
				diagnostics.push(diagnostic(error, { domain: item.key }));
			}
		}
		for (const scope of [...candidateScopes].reverse()) {
			const report = await this.#options.scopes.dispose(scope, this.#cleanupTimeoutMs);
			for (const error of report.errors) {
				diagnostics.push(diagnostic(error.cause, { domain: this.#scopeDomain(prepared, scope) }));
			}
			if (report.timedOut) {
				diagnostics.push({
					severity: "error",
					domain: this.#scopeDomain(prepared, scope),
					message: `Cleanup timed out for resource scope ${scope}`,
				});
			}
		}
	}

	async #retire(
		activated: readonly ActivatedEntry<R>[],
		previous: RuntimeManifest<R, C, E>,
		next: RuntimeManifest<R, C, E>,
		diagnostics: ReloadDiagnostic[],
	): Promise<boolean> {
		let degraded = false;
		const cleanupSignal = AbortSignal.timeout(this.#cleanupTimeoutMs);
		for (const item of [...activated].reverse()) {
			try {
				degraded =
					this.#recordCleanup(
						await this.#awaitCleanup(
							item.value.retire(item.previous, {
								signal: cleanupSignal,
								timeoutMs: this.#cleanupTimeoutMs,
							}),
							cleanupSignal,
						),
						item.key,
						diagnostics,
						"warning",
					) || degraded;
			} catch (error) {
				degraded = true;
				diagnostics.push(diagnostic(error, { domain: item.key, severity: "warning" }));
			}
		}

		const retainedOwners = new Set(
			Object.values(next.resources).flatMap(snapshot => (snapshot as ResourceSnapshot<unknown>).owners),
		);
		const ownerDomains = new Map<ScopeId, ResourceKey<R>[]>();
		for (const key of [...this.#graph.order(Object.keys(previous.resources) as ResourceKey<R>[])].reverse()) {
			for (const owner of previous.resources[key].owners) {
				if (
					owner === this.#options.sessionScope ||
					[...retainedOwners].some(retained => this.#options.scopes.isWithin(retained, owner))
				)
					continue;
				const domains = ownerDomains.get(owner);
				if (domains) {
					if (!domains.includes(key)) domains.push(key);
				} else {
					ownerDomains.set(owner, [key]);
				}
			}
		}
		const owners = [...ownerDomains.keys()].filter(
			owner =>
				![...ownerDomains.keys()].some(other => other !== owner && this.#options.scopes.isWithin(owner, other)),
		);
		for (const owner of owners) {
			const domains = [...ownerDomains.entries()]
				.filter(([candidate]) => this.#options.scopes.isWithin(candidate, owner))
				.flatMap(([, associated]) => associated);
			const report = await this.#options.scopes.dispose(owner, this.#cleanupTimeoutMs);
			if (report.timedOut || report.errors.length > 0) degraded = true;
			for (const error of report.errors) {
				diagnostics.push(
					diagnostic(error.cause, {
						domain: domains[0],
						severity: "warning",
					}),
				);
			}
			if (report.timedOut) {
				diagnostics.push({
					severity: "warning",
					domain: domains[0],
					message: `Cleanup timed out for replaced resource scope ${owner}`,
				});
			}
		}
		return degraded;
	}

	async #waitForOwners(
		manifest: RuntimeManifest<R, C, E>,
		affected: readonly ResourceKey<R>[],
		signal: AbortSignal,
	): Promise<void> {
		const owners = new Set<ScopeId>();
		for (const key of affected) {
			for (const owner of manifest.resources[key].owners) owners.add(owner);
		}
		for (const owner of owners) await this.#options.scopes.waitForIdle(owner, signal);
	}

	async #awaitCleanup(work: Promise<ResourceCleanupResult>, signal: AbortSignal): Promise<ResourceCleanupResult> {
		if (signal.aborted) {
			return { degraded: true, errors: [signal.reason] };
		}
		const timedOut = Promise.withResolvers<ResourceCleanupResult>();
		const onAbort = (): void => {
			timedOut.resolve({ degraded: true, errors: [signal.reason] });
		};
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			return await Promise.race([work, timedOut.promise]);
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}

	#recordCleanup(
		result: ResourceCleanupResult,
		domain: ResourceKey<R>,
		diagnostics: ReloadDiagnostic[],
		severity: ReloadDiagnostic["severity"] = "error",
	): boolean {
		for (const error of result.errors) {
			diagnostics.push(diagnostic(error, { domain, severity }));
		}
		return result.degraded || result.errors.length > 0;
	}

	async #notify(result: ReloadResult<RuntimeManifest<R, C, E>>, diagnostics: ReloadDiagnostic[]): Promise<void> {
		for (const listener of this.#listeners) {
			try {
				await listener(result);
			} catch (error) {
				diagnostics.push(diagnostic(error, { severity: "warning" }));
			}
		}
	}

	#assertUsable(): void {
		if (this.#disposed) throw new Error("Resource runtime is disposed");
		if (this.#poisoned) throw this.#poisoned;
	}

	#poison(cause: unknown): void {
		if (this.#poisoned) return;
		this.#poisoned = new Error("Resource runtime is unusable because consumer rollback failed", { cause });
		this.#lifecycle.abort(this.#poisoned);
		this.#coordinator.close();
	}

	#validateInitialOwners(): void {
		for (const domain of Object.keys(this.#options.definitions) as ResourceKey<R>[]) {
			const owners = this.#current.resources[domain].owners;
			if (new Set(owners).size !== owners.length) {
				throw new Error(`Resource ${domain} initial snapshot contains duplicate owner scopes`);
			}
			for (const owner of owners) this.#validateOwner(domain, owner, "initial snapshot");
		}
	}

	#validateOwner(domain: ResourceKey<R>, owner: ScopeId, description: string): void {
		if (!this.#options.scopes.get(owner)) {
			throw new Error(`Resource ${domain} ${description} references unknown owner scope ${String(owner)}`);
		}
		try {
			this.#options.scopes.assertLive(owner);
		} catch (error) {
			throw new Error(`Resource ${domain} ${description} references non-live owner scope ${String(owner)}`, {
				cause: error,
			});
		}
		if (!this.#options.scopes.isWithin(owner, this.#options.sessionScope)) {
			throw new Error(
				`Resource ${domain} ${description} owner scope ${String(owner)} is outside the runtime session`,
			);
		}
	}
	#candidateSource(key: ResourceKey<R>, revision: number): ResourceSource {
		const source = this.#options.source ?? { kind: "runtime", id: "reload" };
		return { ...source, id: `${source.id}:${key}:${revision}` };
	}
	#validateCandidateOwners(
		domain: ResourceKey<R>,
		candidate: ResourceSnapshot<R[ResourceKey<R>]>,
		candidateScope: ScopeId,
	): void {
		const owners = candidate.owners;
		const candidateCount = owners.filter(owner => owner === candidateScope).length;
		if (candidateCount !== 1) {
			throw new Error(
				`Resource ${domain} candidate must contain its candidate scope exactly once (found ${candidateCount})`,
			);
		}
		if (new Set(owners).size !== owners.length) {
			throw new Error(`Resource ${domain} candidate contains duplicate owner scopes`);
		}
		for (const owner of owners) this.#validateOwner(domain, owner, "candidate");
	}

	#scopeDomain(prepared: readonly PreparedEntry<R>[], scope: ScopeId): ResourceKey<R> | undefined {
		return prepared.find(item => item.scope === scope)?.key;
	}

	#explicitDomains(intents: readonly ReloadIntent<ResourceKey<R>>[]): Set<ResourceKey<R>> {
		const domains = new Set<ResourceKey<R>>();
		for (const intent of intents) {
			if (intent.kind !== "reconcile-config") domains.add(intent.domain);
		}
		return domains;
	}

	#reconcileDomains(intents: readonly ReloadIntent<ResourceKey<R>>[]): Set<ResourceKey<R>> {
		const domains = new Set<ResourceKey<R>>();
		for (const intent of intents) {
			if (intent.kind !== "reconcile-config") continue;
			for (const domain of intent.domains ?? this.#graph.keys) domains.add(domain);
		}
		return domains;
	}

	async #discover(
		desired: DesiredRuntimeState<ResourceKey<R>>,
		signal: AbortSignal,
		domains: ReadonlySet<ResourceKey<R>>,
		current: RuntimeManifest<R, C, E>,
	): Promise<Set<ResourceKey<R>>> {
		const changed = new Set<ResourceKey<R>>();
		for (const key of domains) {
			const fingerprint = await this.#options.definitions[key].fingerprint({ desired, signal });
			if (fingerprint !== current.resources[key].fingerprint) changed.add(key);
		}
		return changed;
	}
}
