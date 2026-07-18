import { describe, expect, test, vi } from "bun:test";
import type {
	ReloadDiagnostic,
	ResourceCleanupResult,
	ResourceDefinitionMap,
} from "../src/runtime/resource-definition";
import {
	ResourceRuntime,
	type RuntimeAssembly,
	type RuntimeAssemblyContext,
	type RuntimeCommitContext,
	type RuntimeValidationContext,
} from "../src/runtime/resource-runtime";
import { type ScopeId, ScopeManager } from "../src/runtime/resource-scope";
import { createRuntimeManifest } from "../src/runtime/runtime-manifest";

type Resources = { base: string; child: number };
type Contributions = { enabled: boolean };
type Effective = { base: string; child: number };
type ResourceDomain = keyof Resources;

const clean: ResourceCleanupResult = { degraded: false, errors: [] };

interface HarnessHooks {
	readonly fingerprint?: (domain: ResourceDomain) => string | Promise<string>;
	readonly prepare?: (domain: ResourceDomain, scope: ScopeId) => void | Promise<void>;
	readonly handoff?: (domain: ResourceDomain) => void | Promise<void>;
	readonly abort?: (domain: ResourceDomain, reason: unknown) => ResourceCleanupResult | Promise<ResourceCleanupResult>;
	readonly compensate?: (
		domain: ResourceDomain,
		reason: unknown,
	) => ResourceCleanupResult | Promise<ResourceCleanupResult>;
	readonly retire?: (domain: ResourceDomain) => ResourceCleanupResult | Promise<ResourceCleanupResult>;
	readonly candidateOwners?: (domain: ResourceDomain, candidateScope: ScopeId) => readonly ScopeId[];
	readonly initialOwners?: (domain: ResourceDomain, defaultOwner: ScopeId) => readonly ScopeId[];
	readonly beforeRuntime?: (scopes: ScopeManager, session: ScopeId, oldBase: ScopeId, oldChild: ScopeId) => void;
	readonly assemble?: (
		context: RuntimeAssemblyContext<Resources, Contributions, Effective>,
	) => RuntimeAssembly<Contributions, Effective> | Promise<RuntimeAssembly<Contributions, Effective>>;
	readonly validate?: (context: RuntimeValidationContext<Resources, Contributions, Effective>) => void | Promise<void>;
	readonly commit?: (context: RuntimeCommitContext<Resources, Contributions, Effective>) => void | Promise<void>;
	readonly rollback?: (context: RuntimeCommitContext<Resources, Contributions, Effective>) => void | Promise<void>;
	readonly listener?: (
		state: "applied" | "unchanged" | "pending" | "failed" | "degraded",
		diagnostics: readonly ReloadDiagnostic[],
	) => void | Promise<void>;
}

function desired(revision: number) {
	return { revision, resources: [] };
}

function reloadBase(revision: number) {
	return {
		desired: desired(revision),
		intents: [{ kind: "refresh-source" as const, domain: "base" as const, sourceId: "test" }],
	};
}

async function settled(promise: Promise<unknown>): Promise<boolean> {
	return Promise.race([
		promise.then(
			() => true,
			() => true,
		),
		Promise.resolve(false),
	]);
}

function setup(hooks: HarnessHooks = {}) {
	const scopes = new ScopeManager("runtime-test");
	const session = scopes.create({ source: { kind: "session", id: "test" } });
	const oldBase = scopes.create({ parent: session.id, source: { kind: "fixture", id: "old-base" } });
	const oldChild = scopes.create({ parent: session.id, source: { kind: "fixture", id: "old-child" } });
	const events: string[] = [];
	scopes.track(oldBase.id, () => {
		events.push("scope:old-base");
	});
	scopes.track(oldChild.id, () => {
		events.push("scope:old-child");
	});
	hooks.beforeRuntime?.(scopes, session.id, oldBase.id, oldChild.id);

	const initial = createRuntimeManifest<Resources, Contributions, Effective>({
		id: 1,
		desiredRevision: 1,
		resources: {
			base: {
				revision: 1,
				fingerprint: "base-1",
				value: "base-1",
				owners: hooks.initialOwners?.("base", oldBase.id) ?? [oldBase.id],
			},
			child: {
				revision: 1,
				fingerprint: "child-1",
				value: 1,
				owners: hooks.initialOwners?.("child", oldChild.id) ?? [oldChild.id],
			},
		},
		contributions: { enabled: true },
		effective: { base: "base-1", child: 1 },
		publishedAt: 0,
	});

	const lifecycle = (domain: ResourceDomain) => ({
		compensate: async (reason: unknown) => {
			events.push(`compensate:${domain}`);
			return (await hooks.compensate?.(domain, reason)) ?? clean;
		},
		retire: async () => {
			events.push(`retire:${domain}`);
			return (await hooks.retire?.(domain)) ?? clean;
		},
	});
	const abort = async (domain: ResourceDomain, reason: unknown) => {
		events.push(`abort:${domain}`);
		return (await hooks.abort?.(domain, reason)) ?? clean;
	};

	const definitions: ResourceDefinitionMap<Resources, Contributions, Effective> = {
		base: {
			key: "base",
			dependencies: [],
			fingerprint: async () => (await hooks.fingerprint?.("base")) ?? "base-2",
			prepare: async ({ candidateScope, previous }) => {
				events.push("prepare:base");
				await hooks.prepare?.("base", candidateScope);
				scopes.track(candidateScope, () => {
					events.push("scope:candidate-base");
				});
				return {
					candidate: {
						revision: previous.revision + 1,
						fingerprint: `base-${previous.revision + 1}`,
						value: `base-${previous.revision + 1}`,
						owners: hooks.candidateOwners?.("base", candidateScope) ?? [candidateScope],
					},
					handoff: async () => {
						events.push("handoff:base");
						await hooks.handoff?.("base");
						return lifecycle("base");
					},
					abort: reason => abort("base", reason),
				};
			},
		},
		child: {
			key: "child",
			dependencies: ["base"],
			fingerprint: async () => (await hooks.fingerprint?.("child")) ?? "child-2",
			prepare: async ({ candidate, candidateScope, previous }) => {
				events.push("prepare:child");
				await hooks.prepare?.("child", candidateScope);
				scopes.track(candidateScope, () => {
					events.push("scope:candidate-child");
				});
				return {
					candidate: {
						revision: previous.revision + 1,
						fingerprint: `child-${previous.revision + 1}`,
						value: candidate.base.value.length,
						owners: hooks.candidateOwners?.("child", candidateScope) ?? [candidateScope],
					},
					handoff: async () => {
						events.push("handoff:child");
						await hooks.handoff?.("child");
						return lifecycle("child");
					},
					abort: reason => abort("child", reason),
				};
			},
		},
	};

	const runtime = new ResourceRuntime({
		sessionScope: session.id,
		scopes,
		definitions,
		initial,
		assembler: {
			assemble:
				hooks.assemble ??
				(({ resources }) => ({
					contributions: { enabled: false },
					effective: {
						base: resources.base.value,
						child: resources.child.value,
					},
				})),
		},
		...(hooks.validate ? { validate: hooks.validate } : {}),
		...(hooks.commit ? { commit: hooks.commit } : {}),
		...(hooks.rollback
			? {
					rollback: async (context: RuntimeCommitContext<Resources, Contributions, Effective>) => {
						events.push("rollback");
						await hooks.rollback?.(context);
					},
				}
			: {}),
		cleanupTimeoutMs: 100,
	});
	if (hooks.listener) {
		runtime.subscribe(result => hooks.listener?.(result.state, result.diagnostics));
	}
	return { runtime, scopes, session, oldBase, oldChild, initial, events };
}

describe("ResourceRuntime", () => {
	test("publishes one dependency-ordered aggregate after admitted work drains", async () => {
		const validated = Promise.withResolvers<void>();
		const listenerStates: string[] = [];
		let runtimeAtPublication: ResourceRuntime<Resources, Contributions, Effective> | undefined;
		let desiredRevisionAtPublication: number | undefined;
		const harness = setup({
			validate: () => {
				validated.resolve();
			},
			listener: state => {
				listenerStates.push(state);
				desiredRevisionAtPublication = runtimeAtPublication?.current.desiredRevision;
			},
		});
		runtimeAtPublication = harness.runtime;
		const admitted = await harness.runtime.admit();
		const reload = harness.runtime.requestReload(reloadBase(2));
		await validated.promise;

		expect(admitted.manifest).toBe(harness.initial);
		expect(await settled(reload)).toBe(false);
		admitted.release();

		const result = await reload;
		const next = await harness.runtime.admit();
		expect(result.state).toBe("applied");
		expect(result.manifest).toBe(harness.runtime.current);
		expect(result.manifest.resources.base.value).toBe("base-2");
		expect(result.manifest.resources.child.value).toBe(6);
		expect(result.manifest.contributions).toEqual({ enabled: false });
		expect(result.manifest.effective).toEqual({ base: "base-2", child: 6 });
		expect(next.manifest).toBe(result.manifest);
		expect(listenerStates).toEqual(["applied"]);
		expect(desiredRevisionAtPublication).toBe(2);
		expect(harness.events.slice(0, 6)).toEqual([
			"prepare:base",
			"prepare:child",
			"handoff:base",
			"handoff:child",
			"retire:child",
			"retire:base",
		]);
		expect(harness.scopes.get(harness.oldBase.id)?.disposed).toBe(true);
		expect(harness.scopes.get(harness.oldChild.id)?.disposed).toBe(true);
		expect(harness.runtime.status.get("base")).toEqual(
			expect.objectContaining({ state: "current", appliedRevision: 2, desiredRevision: 2 }),
		);
		next.release();
		await harness.runtime.dispose();
	});

	test("retires replaced owner scopes in reverse dependency order", async () => {
		const harness = setup();
		const result = await harness.runtime.requestReload(reloadBase(2));

		expect(result.state).toBe("applied");
		expect(harness.events.indexOf("scope:old-child")).toBeGreaterThan(-1);
		expect(harness.events.indexOf("scope:old-base")).toBeGreaterThan(-1);
		expect(harness.events.indexOf("scope:old-child")).toBeLessThan(harness.events.indexOf("scope:old-base"));
		await harness.runtime.dispose();
	});

	test("rejects foreign and duplicate candidate owners before publication", async () => {
		const foreignScopes = new ScopeManager("foreign-runtime");
		const foreignSession = foreignScopes.create({ source: { kind: "session", id: "foreign" } });
		const foreignOwner = foreignScopes.create({
			parent: foreignSession.id,
			source: { kind: "foreign", id: "owner" },
		});
		const foreignHarness = setup({
			candidateOwners: (_, candidateScope) => [candidateScope, foreignOwner.id],
		});
		const foreignResult = await foreignHarness.runtime.requestReload(reloadBase(2));

		expect(foreignResult.diagnostics.some(item => item.message.includes("unknown owner scope"))).toBe(true);
		expect(foreignResult.manifest).toBe(foreignHarness.initial);
		expect(foreignHarness.events.filter(event => event === "abort:base")).toHaveLength(1);
		await foreignHarness.runtime.dispose();
		await foreignScopes.dispose(foreignSession.id);

		const duplicateHarness = setup({
			candidateOwners: (_, candidateScope) => [candidateScope, candidateScope],
		});
		const duplicateResult = await duplicateHarness.runtime.requestReload(reloadBase(2));

		expect(duplicateResult.state).toBe("failed");
		expect(duplicateResult.manifest).toBe(duplicateHarness.initial);
		expect(duplicateResult.diagnostics.some(item => item.message.includes("exactly once"))).toBe(true);
		expect(duplicateHarness.events.filter(event => event === "abort:base")).toHaveLength(1);
		await duplicateHarness.runtime.dispose();
	});
	test("aborts prepared resources in reverse order when candidate validation fails", async () => {
		const harness = setup({
			validate: () => {
				throw new Error("invalid aggregate");
			},
		});
		const result = await harness.runtime.requestReload(reloadBase(2));

		expect(result.state).toBe("failed");
		expect(result.manifest).toBe(harness.initial);
		expect(harness.runtime.current).toBe(harness.initial);
		expect(harness.events.slice(0, 8)).toEqual([
			"prepare:base",
			"prepare:child",
			"abort:child",
			"abort:base",
			"scope:candidate-child",
			"scope:candidate-base",
		]);
		expect(result.diagnostics.some(item => item.message === "invalid aggregate")).toBe(true);
		expect(harness.runtime.status.get("child")?.state).toBe("failed");
		await harness.runtime.dispose();
	});

	test("compensates activated resources and restores admission after handoff failure", async () => {
		const harness = setup({
			handoff: domain => {
				if (domain === "child") throw new Error("child activation failed");
			},
		});
		const result = await harness.runtime.requestReload(reloadBase(2));

		expect(result.state).toBe("failed");
		expect(result.manifest).toBe(harness.initial);
		expect(harness.events.slice(0, 8)).toEqual([
			"prepare:base",
			"prepare:child",
			"handoff:base",
			"handoff:child",
			"abort:child",
			"compensate:base",
			"scope:candidate-child",
			"scope:candidate-base",
		]);
		const admitted = await harness.runtime.admit();
		expect(admitted.manifest).toBe(harness.initial);
		admitted.release();
		await harness.runtime.dispose();
	});

	test("compensates every activation when the synchronous commit sink rejects publication", async () => {
		let commitAffected: readonly ResourceDomain[] = [];
		let rollbackAffected: readonly ResourceDomain[] = [];
		const listenerStates: string[] = [];
		const harness = setup({
			commit: ({ affected }) => {
				commitAffected = affected;
				throw new Error("consumer commit failed");
			},
			rollback: ({ affected }) => {
				rollbackAffected = affected;
			},
			listener: state => {
				listenerStates.push(state);
			},
		});
		const result = await harness.runtime.requestReload(reloadBase(2));

		expect(result.state).toBe("failed");
		expect(harness.runtime.current).toBe(harness.initial);
		expect(harness.events).toContain("compensate:child");
		expect(harness.events).toContain("compensate:base");
		expect(harness.events).not.toContain("retire:child");
		expect(harness.events.indexOf("compensate:child") < harness.events.indexOf("compensate:base")).toBe(true);
		expect(commitAffected).toEqual(["base", "child"]);
		expect(rollbackAffected).toEqual(["base", "child"]);
		expect(harness.events.indexOf("compensate:base") < harness.events.indexOf("rollback")).toBe(true);
		expect(listenerStates).toEqual(["failed"]);
		await harness.runtime.dispose();
	});

	test("keeps admission closed until an asynchronous commit failure is compensated", async () => {
		const commitStarted = Promise.withResolvers<void>();
		const finishCommit = Promise.withResolvers<void>();
		const harness = setup({
			commit: async () => {
				commitStarted.resolve();
				await finishCommit.promise;
				throw new Error("asynchronous consumer commit failed");
			},
		});
		const reload = harness.runtime.requestReload(reloadBase(2));
		await commitStarted.promise;
		const queuedAdmission = harness.runtime.admit();
		expect(await settled(queuedAdmission)).toBe(false);

		finishCommit.resolve();
		const result = await reload;
		expect(result.state).toBe("failed");
		expect(result.manifest).toBe(harness.initial);
		expect(harness.events).toContain("compensate:child");
		expect(harness.events).toContain("compensate:base");
		expect(harness.events).not.toContain("retire:child");

		const admitted = await queuedAdmission;
		expect(admitted.manifest).toBe(harness.initial);
		admitted.release();
		await harness.runtime.dispose();
	});
	test("keeps the new manifest admitted while post-publication retirement degrades", async () => {
		const retirementStarted = Promise.withResolvers<void>();
		const finishRetirement = Promise.withResolvers<ResourceCleanupResult>();
		const listenerStates: string[] = [];
		const harness = setup({
			retire: domain => {
				if (domain !== "child") return clean;
				retirementStarted.resolve();
				return finishRetirement.promise;
			},
			listener: state => {
				listenerStates.push(state);
			},
		});
		const reload = harness.runtime.requestReload(reloadBase(2));
		await retirementStarted.promise;

		const queuedAdmission = harness.runtime.admit();
		expect(await settled(queuedAdmission)).toBe(false);
		finishRetirement.resolve({
			degraded: true,
			errors: [new Error("old child cleanup failed")],
		});

		const admitted = await queuedAdmission;
		expect(admitted.manifest).toBe(harness.runtime.current);
		expect(admitted.manifest).not.toBe(harness.initial);
		admitted.release();

		const result = await reload;
		expect(result.state).toBe("degraded");
		expect(result.manifest).toBe(harness.runtime.current);
		expect(result.diagnostics.some(item => item.message === "old child cleanup failed")).toBe(true);
		expect(harness.runtime.status.get("base")?.state).toBe("degraded");
		expect(listenerStates).toEqual(["degraded"]);
		expect(harness.events).not.toContain("compensate:base");
		await harness.runtime.dispose();
	});

	test("bounds a retirement adapter that ignores its abort signal", async () => {
		vi.useFakeTimers();
		try {
			const retirementStarted = Promise.withResolvers<void>();
			const neverRetires = Promise.withResolvers<ResourceCleanupResult>();
			const harness = setup({
				retire: domain => {
					if (domain !== "child") return clean;
					retirementStarted.resolve();
					return neverRetires.promise;
				},
			});
			const reload = harness.runtime.requestReload(reloadBase(2));
			await retirementStarted.promise;
			expect(await settled(reload)).toBe(false);

			vi.advanceTimersByTime(100);
			const result = await reload;
			expect(result.state).toBe("degraded");
			expect(result.manifest).toBe(harness.runtime.current);
			expect(harness.scopes.get(harness.oldChild.id)?.disposed).toBe(true);
			await harness.runtime.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	test("serializes concurrent requests against successive immutable manifests", async () => {
		let activeAssemblies = 0;
		let maximumAssemblies = 0;
		const seenManifestIds: number[] = [];
		const firstAssemblyStarted = Promise.withResolvers<void>();
		const resumeFirstAssembly = Promise.withResolvers<void>();
		const harness = setup({
			assemble: async context => {
				activeAssemblies++;
				maximumAssemblies = Math.max(maximumAssemblies, activeAssemblies);
				seenManifestIds.push(context.current.id);
				if (context.current.id === 1) {
					firstAssemblyStarted.resolve();
					await resumeFirstAssembly.promise;
				}
				activeAssemblies--;
				return {
					contributions: { enabled: false },
					effective: {
						base: context.resources.base.value,
						child: context.resources.child.value,
					},
				};
			},
		});

		const first = harness.runtime.requestReload(reloadBase(2));
		await firstAssemblyStarted.promise;
		const second = harness.runtime.requestReload(reloadBase(3));
		expect(seenManifestIds).toEqual([1]);
		resumeFirstAssembly.resolve();
		const [firstResult, secondResult] = await Promise.all([first, second]);

		expect(firstResult.manifest.id).toBe(2);
		expect(secondResult.manifest.id).toBe(3);
		expect(secondResult.manifest.resources.base.revision).toBe(3);
		expect(seenManifestIds).toEqual([1, 2]);
		expect(maximumAssemblies).toBe(1);
		await harness.runtime.dispose();
	});

	test("records a newer desired revision without rebuilding unchanged resources", async () => {
		let prepares = 0;
		let assemblies = 0;
		let commits = 0;
		let committedAffected: readonly ResourceDomain[] | undefined;
		const harness = setup({
			fingerprint: domain => `${domain}-1`,
			prepare: () => {
				prepares++;
			},
			assemble: context => {
				assemblies++;
				return {
					contributions: context.previousContributions,
					effective: context.current.effective,
				};
			},
			commit: ({ affected }) => {
				commits++;
				committedAffected = affected;
			},
		});
		const result = await harness.runtime.requestReload({
			desired: desired(7),
			intents: [{ kind: "reconcile-config" }],
		});

		expect(result.state).toBe("unchanged");
		expect(result.manifest.id).toBe(2);
		expect(result.manifest.desiredRevision).toBe(7);
		expect(result.manifest.resources.base).toBe(harness.initial.resources.base);
		expect(prepares).toBe(0);
		expect(assemblies).toBe(0);
		expect(commits).toBe(1);
		expect(committedAffected).toEqual([]);
		expect(harness.runtime.status.get("base")?.state).toBe("current");
		await harness.runtime.dispose();
	});

	test("returns a failed result for a malformed domain request", async () => {
		const harness = setup();
		const result = await harness.runtime.requestReload({
			desired: desired(2),
			intents: [
				{
					kind: "refresh-source",
					domain: "unknown" as ResourceDomain,
					sourceId: "test",
				},
			],
		});

		expect(result.state).toBe("failed");
		expect(result.manifest).toBe(harness.initial);
		expect(result.diagnostics.some(item => item.message.includes("Unknown resource domain"))).toBe(true);
		await harness.runtime.dispose();
	});

	test("compensates an activated candidate when disposal interrupts handoff", async () => {
		const handoffStarted = Promise.withResolvers<void>();
		const finishHandoff = Promise.withResolvers<void>();
		const harness = setup({
			handoff: async domain => {
				if (domain !== "base") return;
				handoffStarted.resolve();
				await finishHandoff.promise;
			},
		});
		const reload = harness.runtime.requestReload(reloadBase(2));
		await handoffStarted.promise;

		const disposal = harness.runtime.dispose(100);
		finishHandoff.resolve();
		const result = await reload;

		expect(result.state).toBe("failed");
		expect(result.manifest).toBe(harness.initial);
		expect(harness.events).toContain("compensate:base");
		expect(harness.events).not.toContain("handoff:child");
		await disposal;
	});

	test("disposal rejects new work and waits for the last admitted operation", async () => {
		const harness = setup();
		const admitted = await harness.runtime.admit();
		const firstDispose = harness.runtime.dispose(100);
		const secondDispose = harness.runtime.dispose(1);

		expect(secondDispose).toBe(firstDispose);
		expect(await settled(firstDispose)).toBe(false);
		await expect(harness.runtime.admit()).rejects.toThrow("disposed");
		await expect(harness.runtime.requestReload(reloadBase(2))).rejects.toThrow("disposed");
		admitted.release();
		await firstDispose;
		expect(harness.scopes.get(harness.session.id)).toEqual(
			expect.objectContaining({ revoked: true, disposed: true }),
		);
	});
	test("awaits asynchronous listeners and reports their rejection", async () => {
		const harness = setup({
			listener: async () => {
				await Promise.resolve();
				throw new Error("async listener failed");
			},
		});

		const result = await harness.runtime.requestReload(reloadBase(2));
		expect(result.state).toBe("applied");
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({ severity: "warning", message: "async listener failed" }),
		);
		await harness.runtime.dispose();
	});

	test("poisons admissions and queued reloads when consumer rollback cannot restore state", async () => {
		const commitStarted = Promise.withResolvers<void>();
		const failCommit = Promise.withResolvers<void>();
		const harness = setup({
			commit: async () => {
				commitStarted.resolve();
				await failCommit.promise;
				throw new Error("commit failed");
			},
			rollback: () => {
				throw new Error("rollback failed");
			},
		});

		const first = harness.runtime.requestReload(reloadBase(2));
		await commitStarted.promise;
		const queuedAdmission = harness.runtime.admit();
		const queuedReload = harness.runtime.requestReload(reloadBase(3));
		failCommit.resolve();

		const result = await first;
		expect(result.state).toBe("failed");
		expect(result.diagnostics.map(item => item.message)).toEqual(
			expect.arrayContaining(["commit failed", "rollback failed"]),
		);
		await expect(queuedAdmission).rejects.toThrow("unusable");
		await expect(queuedReload).rejects.toThrow("unusable");
		await expect(harness.runtime.admit()).rejects.toThrow("unusable");
		await expect(harness.runtime.requestReload(reloadBase(4))).rejects.toThrow("unusable");
		await harness.runtime.dispose();
	});

	test("returns immutable status records instead of mutable internal values", async () => {
		const harness = setup();
		await harness.runtime.requestReload(reloadBase(2));

		const status = harness.runtime.status.get("base");
		expect(status).toBeDefined();
		expect(Object.isFrozen(status)).toBe(true);
		await harness.runtime.dispose();
	});

	test("rejects disposal when final scope cleanup reports errors", async () => {
		const harness = setup();
		harness.scopes.track(harness.session.id, () => {
			throw new Error("session cleanup failed");
		});

		await expect(harness.runtime.dispose()).rejects.toThrow("did not complete cleanly");
	});
	test("rejects duplicate, unknown, non-live, and out-of-session initial owners", () => {
		expect(() =>
			setup({
				initialOwners: (_, owner) => [owner, owner],
			}),
		).toThrow("duplicate owner scopes");

		expect(() =>
			setup({
				initialOwners: domain => (domain === "base" ? ["missing" as ScopeId] : []),
			}),
		).toThrow("unknown owner scope");

		expect(() =>
			setup({
				beforeRuntime: (scopes, _session, oldBase) => {
					scopes.revoke(oldBase);
				},
			}),
		).toThrow("non-live owner scope");

		let outsideOwner: ScopeId | undefined;
		expect(() =>
			setup({
				beforeRuntime: scopes => {
					outsideOwner = scopes.create({ source: { kind: "fixture", id: "outside" } }).id;
				},
				initialOwners: (domain, owner) => (domain === "base" ? [outsideOwner!] : [owner]),
			}),
		).toThrow("outside the runtime session");
	});
});
