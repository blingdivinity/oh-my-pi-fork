import { describe, expect, test } from "bun:test";
import { CLEAN, ManagedValueResource, type ManagedValueResourceLifecycle } from "../src/runtime/managed-value-resource";
import type { ResourceCleanupResult, ResourceDefinitionMap } from "../src/runtime/resource-definition";
import { ResourceRuntime } from "../src/runtime/resource-runtime";
import { ScopeManager } from "../src/runtime/resource-scope";
import { createRuntimeManifest } from "../src/runtime/runtime-manifest";

type SingleResources = { value: string };
type SingleContributions = { enabled: boolean };
type SingleEffective = { value: string };

type PairResources = { base: string; child: number };
type PairContributions = { enabled: boolean };
type PairEffective = { base: string; child: number };

const desired = (revision: number) => ({ revision, resources: [] });

async function reloadSingle(
	runtime: ResourceRuntime<SingleResources, SingleContributions, SingleEffective>,
	revision: number,
) {
	const admission = await runtime.admit();
	const reload = runtime.requestReload({
		desired: desired(revision),
		intents: [{ kind: "refresh-source", domain: "value", sourceId: "test" }],
	});
	admission.release();
	return reload;
}

function singleRuntime(resource: ManagedValueResource<string>) {
	const scopes = new ScopeManager("managed-single");
	const session = scopes.create({ source: { kind: "session", id: "test" } });
	const old = scopes.create({ parent: session.id, source: { kind: "fixture", id: "old" } });
	const definition = resource.definition<SingleResources, SingleContributions, SingleEffective, "value">("value", []);
	const definitions: ResourceDefinitionMap<SingleResources, SingleContributions, SingleEffective> = {
		value: definition,
	};
	const initial = createRuntimeManifest<SingleResources, SingleContributions, SingleEffective>({
		id: 1,
		desiredRevision: 1,
		resources: {
			value: { revision: 1, fingerprint: "v1", value: "old", owners: [old.id] },
		},
		contributions: { enabled: true },
		effective: { value: "old" },
		publishedAt: 0,
	});
	const runtime = new ResourceRuntime({
		sessionScope: session.id,
		scopes,
		definitions,
		initial,
		assembler: {
			assemble: ({ resources }) => ({
				contributions: { enabled: true },
				effective: { value: resources.value.value },
			}),
		},
		cleanupTimeoutMs: 1,
	});
	return { runtime, scopes, old };
}

describe("ManagedValueResource", () => {
	test("stages an owned immutable candidate and publishes external state only at handoff", async () => {
		const events: string[] = [];
		let active = "old";
		const lifecycle: ManagedValueResourceLifecycle<string> = {
			prepare: ({ candidate, previous, context }) => {
				events.push("prepare");
				expect(candidate.value).toBe("new");
				expect(previous.value).toBe("old");
				expect(candidate.owners).toEqual([context.candidateScope]);
				expect(active).toBe("old");
			},
			handoff: ({ candidate }) => {
				events.push("handoff");
				active = candidate.value;
			},
			retire: previous => {
				events.push("retire");
				expect(previous.value).toBe("old");
				return undefined;
			},
		};
		const resource = new ManagedValueResource({ value: "old", fingerprint: "v1", lifecycle });
		resource.stage("new", "v2");
		const { runtime, scopes, old } = singleRuntime(resource);

		const result = await reloadSingle(runtime, 2);
		expect(result.state).toBe("applied");
		expect(events).toEqual(["prepare", "handoff", "retire"]);
		expect(active).toBe("new");
		expect(result.manifest.resources.value.value).toBe("new");
		expect(Object.isFrozen(result.manifest.resources.value)).toBe(true);
		expect(result.manifest.resources.value.owners).not.toContain(old.id);
		expect(scopes.get(old.id)?.disposed).toBe(true);
		expect(resource.desired).toEqual({ value: "new", fingerprint: "v2" });
		await runtime.dispose();
	});

	test("captures the staged lifecycle generation during prepare", async () => {
		const events: string[] = [];
		const resource = new ManagedValueResource({ value: "old", fingerprint: "v1" });
		resource.stage("new", "v2", {
			prepare: () => {
				events.push("prepare:first");
				resource.stage("later", "v3", {
					handoff: () => {
						events.push("handoff:later");
					},
				});
			},
			handoff: () => {
				events.push("handoff:first");
			},
		});
		const { runtime } = singleRuntime(resource);

		const result = await reloadSingle(runtime, 2);
		expect(result.manifest.resources.value.value).toBe("new");
		expect(events).toEqual(["prepare:first", "handoff:first"]);
		expect(resource.desired).toEqual({ value: "later", fingerprint: "v3" });
		await runtime.dispose();
	});

	test("aborts prepared candidates before handoff when validation fails", async () => {
		const events: string[] = [];
		let active = "old";
		const resource = new ManagedValueResource({ value: "old", fingerprint: "v1" });
		resource.stage("new", "v2", {
			prepare: () => {
				events.push("prepare");
			},
			handoff: () => {
				events.push("handoff");
				active = "new";
			},
			abort: () => {
				events.push("abort");
				return CLEAN;
			},
		});
		// Build a validation-failing runtime with the same definition and scopes.
		const scopes = new ScopeManager("managed-abort");
		const session = scopes.create({ source: { kind: "session", id: "test" } });
		const old = scopes.create({ parent: session.id, source: { kind: "fixture", id: "old" } });
		const definitions: ResourceDefinitionMap<SingleResources, SingleContributions, SingleEffective> = {
			value: resource.definition<SingleResources, SingleContributions, SingleEffective, "value">("value", []),
		};
		const initial = createRuntimeManifest<SingleResources, SingleContributions, SingleEffective>({
			id: 1,
			desiredRevision: 1,
			resources: { value: { revision: 1, fingerprint: "v1", value: "old", owners: [old.id] } },
			contributions: { enabled: true },
			effective: { value: "old" },
			publishedAt: 0,
		});
		const runtimeWithValidation = new ResourceRuntime({
			sessionScope: session.id,
			scopes,
			definitions,
			initial,
			assembler: {
				assemble: ({ resources }) => ({
					contributions: { enabled: true },
					effective: { value: resources.value.value },
				}),
			},
			validate: () => {
				throw new Error("invalid candidate");
			},
			cleanupTimeoutMs: 1,
		});

		const result = await reloadSingle(runtimeWithValidation, 2);
		expect(result.state).toBe("failed");
		expect(events).toEqual(["prepare", "abort"]);
		expect(active).toBe("old");
		await runtimeWithValidation.dispose();
	});

	test("compensates activated resources after a later handoff fails", async () => {
		const events: string[] = [];
		const base = new ManagedValueResource({ value: "base-1", fingerprint: "base-1" });
		base.stage("base-2", "base-2", {
			prepare: () => {
				events.push("prepare:base");
			},
			handoff: () => {
				events.push("handoff:base");
			},
			compensate: () => {
				events.push("compensate:base");
				return undefined;
			},
		});
		const child = new ManagedValueResource({ value: 1, fingerprint: "child-1" });
		child.stage(2, "child-2", {
			prepare: () => {
				events.push("prepare:child");
			},
			handoff: () => {
				events.push("handoff:child");
				throw new Error("child handoff failed");
			},
			abort: () => {
				events.push("abort:child");
				return undefined;
			},
		});

		const scopes = new ScopeManager("managed-compensate");
		const session = scopes.create({ source: { kind: "session", id: "test" } });
		const oldBase = scopes.create({ parent: session.id, source: { kind: "fixture", id: "old-base" } });
		const oldChild = scopes.create({ parent: session.id, source: { kind: "fixture", id: "old-child" } });
		const definitions: ResourceDefinitionMap<PairResources, PairContributions, PairEffective> = {
			base: base.definition<PairResources, PairContributions, PairEffective, "base">("base", []),
			child: child.definition<PairResources, PairContributions, PairEffective, "child">("child", ["base"]),
		};
		const initial = createRuntimeManifest<PairResources, PairContributions, PairEffective>({
			id: 1,
			desiredRevision: 1,
			resources: {
				base: { revision: 1, fingerprint: "base-1", value: "base-1", owners: [oldBase.id] },
				child: { revision: 1, fingerprint: "child-1", value: 1, owners: [oldChild.id] },
			},
			contributions: { enabled: true },
			effective: { base: "base-1", child: 1 },
			publishedAt: 0,
		});
		const runtime = new ResourceRuntime({
			sessionScope: session.id,
			scopes,
			definitions,
			initial,
			assembler: {
				assemble: ({ resources }) => ({
					contributions: { enabled: true },
					effective: { base: resources.base.value, child: resources.child.value },
				}),
			},
			cleanupTimeoutMs: 1,
		});

		const admission = await runtime.admit();
		const reload = runtime.requestReload({
			desired: desired(2),
			intents: [
				{ kind: "refresh-source", domain: "base", sourceId: "test" },
				{ kind: "refresh-source", domain: "child", sourceId: "test" },
			],
		});
		admission.release();
		const result = await reload;
		expect(result.state).toBe("failed");
		expect(events).toEqual([
			"prepare:base",
			"prepare:child",
			"handoff:base",
			"handoff:child",
			"abort:child",
			"compensate:base",
		]);
		expect(runtime.current.resources.base.value).toBe("base-1");
		await runtime.dispose();
	});

	test("reports degraded state when retiring the replaced value fails", async () => {
		const retirementError = new Error("retire failed");
		const resource = new ManagedValueResource({ value: "old", fingerprint: "v1" });
		resource.stage("new", "v2", {
			retire: () => {
				const result: ResourceCleanupResult = { degraded: true, errors: [retirementError] };
				return result;
			},
		});
		const { runtime } = singleRuntime(resource);

		const result = await reloadSingle(runtime, 2);
		expect(result.state).toBe("degraded");
		expect(runtime.status.get("value")?.state).toBe("degraded");
		expect(result.diagnostics.some(diagnostic => diagnostic.cause === retirementError)).toBe(true);
		await runtime.dispose();
	});
});
