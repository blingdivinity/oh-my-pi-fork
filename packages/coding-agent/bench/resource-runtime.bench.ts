/**
 * Deterministic ResourceRuntime transaction benchmark.
 *
 * Measures production runtime reconciliation over a ten-domain dependency chain:
 * unchanged reconciliation, a leaf replacement, and a root replacement that
 * cascades through every dependent domain. Timings are machine-relative and are
 * intended for local comparison between changes, not wall-clock thresholds.
 *
 * Run: bun packages/coding-agent/bench/resource-runtime.bench.ts
 */

import type {
	DesiredRuntimeState,
	ReloadIntent,
	ResourceDefinitionMap,
	ResourceKey,
	ReloadResult,
} from "../src/runtime/resource-definition";
import { ManagedValueResource } from "../src/runtime/managed-value-resource";
import { ResourceGraph } from "../src/runtime/resource-graph";
import { ResourceRuntime, type RuntimeCommitContext } from "../src/runtime/resource-runtime";
import { ScopeManager, type ScopeId } from "../src/runtime/resource-scope";
import { createRuntimeManifest, type ResourceSnapshotMap } from "../src/runtime/runtime-manifest";

const DOMAIN_KEYS = [
	"root",
	"session",
	"config",
	"tools",
	"prompts",
	"extensions",
	"models",
	"permissions",
	"ui",
	"transport",
] as const;
type Domain = (typeof DOMAIN_KEYS)[number];
type Resources = { readonly [K in Domain]: number };
type Contributions = { readonly total: number };
type Effective = { readonly total: number; readonly revisions: readonly number[] };

const DEPENDENCIES: Readonly<Record<Domain, readonly Domain[]>> = {
	root: [],
	session: ["root"],
	config: ["session"],
	tools: ["config"],
	prompts: ["tools"],
	extensions: ["prompts"],
	models: ["extensions"],
	permissions: ["models"],
	ui: ["permissions"],
	transport: ["ui"],
};

const SOURCE = Object.freeze({ kind: "benchmark", id: "resource-runtime-bench" });
const DEFAULT_ITERATIONS = 500;
const DEFAULT_WARMUP = 50;

function envCount(name: string, fallback: number): number {
	const raw = Bun.env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new Error(`${name} must be a positive integer (received ${JSON.stringify(raw)})`);
	}
	return value;
}

const ITERATIONS = envCount("RESOURCE_RUNTIME_BENCH_ITERATIONS", DEFAULT_ITERATIONS);
const WARMUP = envCount("RESOURCE_RUNTIME_BENCH_WARMUP", DEFAULT_WARMUP);

interface Fixture {
	readonly runtime: ResourceRuntime<Resources, Contributions, Effective>;
	readonly staged: Readonly<Record<Domain, ManagedValueResource<number>>>;
	readonly stats: {
		commitCount: number;
		lastAffected: readonly Domain[];
	};
}

function makeDesired(revision: number): DesiredRuntimeState<ResourceKey<Resources>> {
	return {
		revision,
		resources: DOMAIN_KEYS.map(domain => ({
			domain,
			source: SOURCE,
			fingerprint: `${domain}-desired`,
			enabled: true,
		})),
	};
}

function makeFixture(): Fixture {
	const scopes = new ScopeManager("resource-runtime-bench");
	const sessionScope = scopes.create({ source: { kind: "session", id: "bench-session" } }).id;
	const staged = Object.fromEntries(
		DOMAIN_KEYS.map((domain, index) => [
			domain,
			new ManagedValueResource<number>({ value: index + 1, fingerprint: `${domain}-1` }),
		]),
	) as Record<Domain, ManagedValueResource<number>>;
	const initialOwners = Object.fromEntries(
		DOMAIN_KEYS.map(domain => [
			domain,
			scopes.create({
				parent: sessionScope,
				source: { kind: "initial-resource", id: domain },
				revision: 1,
			}).id,
		]),
	) as Record<Domain, ScopeId>;
	const initialResources = Object.fromEntries(
		DOMAIN_KEYS.map((domain, index) => [
			domain,
			{
				revision: 1,
				fingerprint: `${domain}-1`,
				value: index + 1,
				owners: [initialOwners[domain]],
			},
		]),
	) as ResourceSnapshotMap<Resources>;
	const graph = new ResourceGraph<Domain>(
		DOMAIN_KEYS.map(domain => ({ key: domain, dependencies: DEPENDENCIES[domain] })),
	);
	const definitions = Object.fromEntries(
		DOMAIN_KEYS.map(domain => [
			domain,
			staged[domain].definition<Resources, Contributions, Effective, Domain>(domain, DEPENDENCIES[domain]),
		]),
	) as ResourceDefinitionMap<Resources, Contributions, Effective>;
	const initialEffective: Effective = {
		total: DOMAIN_KEYS.reduce((total, domain) => total + initialResources[domain].value, 0),
		revisions: DOMAIN_KEYS.map(() => 1),
	};
	const initial = createRuntimeManifest<Resources, Contributions, Effective>({
		id: 1,
		desiredRevision: 1,
		resources: initialResources,
		contributions: { total: initialEffective.total },
		effective: initialEffective,
		publishedAt: 0,
	});
	const stats: Fixture["stats"] = { commitCount: 0, lastAffected: [] };
	const runtime = new ResourceRuntime<Resources, Contributions, Effective>({
		sessionScope,
		scopes,
		definitions,
		graph,
		initial,
		assembler: {
			assemble: ({ resources }) => {
				let total = 0;
				const revisions: number[] = [];
				for (const domain of DOMAIN_KEYS) {
					total += resources[domain].value;
					revisions.push(resources[domain].revision);
				}
				return { contributions: { total }, effective: { total, revisions } };
			},
		},
		commit: ({ affected }: RuntimeCommitContext<Resources, Contributions, Effective>) => {
			stats.commitCount++;
			stats.lastAffected = affected;
		},
		cleanupTimeoutMs: 100,
	});
	return { runtime, staged, stats };
}

function expect(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(`Benchmark sanity check failed: ${message}`);
}

function expectEqual<T>(actual: T, expected: T, message: string): void {
	if (actual !== expected) {
		throw new Error(`Benchmark sanity check failed: ${message} (expected ${String(expected)}, got ${String(actual)})`);
	}
}

function expectDomainList(actual: readonly Domain[], expected: readonly Domain[], message: string): void {
	expect(actual.length === expected.length && actual.every((domain, index) => domain === expected[index]), message);
}

async function request(
	fixture: Fixture,
	revision: number,
	intents: readonly ReloadIntent<Domain>[],
): Promise<ReloadResult<unknown>> {
	return fixture.runtime.requestReload({ desired: makeDesired(revision), intents });
}

interface Measurement {
	readonly millisecondsPerOperation: number;
	readonly operationsPerSecond: number;
}

async function measure(
	fixture: Fixture,
	operation: (iteration: number) => Promise<ReloadResult<unknown>>,
): Promise<Measurement> {
	for (let iteration = 0; iteration < WARMUP; iteration++) await operation(iteration);
	const start = Bun.nanoseconds();
	for (let iteration = 0; iteration < ITERATIONS; iteration++) await operation(iteration + WARMUP);
	const elapsedMs = (Bun.nanoseconds() - start) / 1e6;
	const millisecondsPerOperation = elapsedMs / ITERATIONS;
	return { millisecondsPerOperation, operationsPerSecond: 1000 / millisecondsPerOperation };
}

async function runNoOp(): Promise<Measurement> {
	const fixture = makeFixture();
	try {
		const measurement = await measure(fixture, async iteration =>
			request(fixture, iteration + 2, [{ kind: "reconcile-config", domains: DOMAIN_KEYS }]),
		);
		const current = fixture.runtime.current;
		expectEqual(fixture.stats.commitCount, WARMUP + ITERATIONS, "no-op commit count");
		expectEqual(current.id, 1 + WARMUP + ITERATIONS, "no-op manifest publication count");
		expectEqual(current.desiredRevision, 1 + WARMUP + ITERATIONS, "no-op desired revision");
		expect(DOMAIN_KEYS.every(domain => current.resources[domain].revision === 1), "no-op resource revisions stay unchanged");
		expectEqual(fixture.stats.lastAffected.length, 0, "no-op commit has no affected domains");
		return measurement;
	} finally {
		await fixture.runtime.dispose();
	}
}

async function runLeaf(): Promise<Measurement> {
	const fixture = makeFixture();
	const leaf = DOMAIN_KEYS[DOMAIN_KEYS.length - 1];
	try {
		const measurement = await measure(fixture, async iteration => {
			fixture.staged[leaf].stage(iteration + 2, `${leaf}-${iteration + 2}`);
			return request(fixture, iteration + 2, [{ kind: "reconcile-config", domains: [leaf] }]);
		});
		const current = fixture.runtime.current;
		expectEqual(fixture.stats.commitCount, WARMUP + ITERATIONS, "leaf commit count");
		expectEqual(current.resources[leaf].revision, 1 + WARMUP + ITERATIONS, "leaf revision");
		for (const domain of DOMAIN_KEYS.slice(0, -1)) expectEqual(current.resources[domain].revision, 1, `${domain} remains unchanged for leaf replacement`);
		expectDomainList(fixture.stats.lastAffected, [leaf], "leaf commit affects only the leaf");
		return measurement;
	} finally {
		await fixture.runtime.dispose();
	}
}

async function runRootCascade(): Promise<Measurement> {
	const fixture = makeFixture();
	const root = DOMAIN_KEYS[0];
	try {
		const measurement = await measure(fixture, async iteration => {
			fixture.staged[root].stage(iteration + 2, `${root}-${iteration + 2}`);
			return request(fixture, iteration + 2, [{ kind: "reconcile-config", domains: [root] }]);
		});
		const current = fixture.runtime.current;
		expectEqual(fixture.stats.commitCount, WARMUP + ITERATIONS, "root-cascade commit count");
		for (const domain of DOMAIN_KEYS) expectEqual(current.resources[domain].revision, 1 + WARMUP + ITERATIONS, `${domain} revision after root cascade`);
		expectDomainList(fixture.stats.lastAffected, DOMAIN_KEYS, "root commit dependency order");
		return measurement;
	} finally {
		await fixture.runtime.dispose();
	}
}

const noOp = await runNoOp();
const leaf = await runLeaf();
const rootCascade = await runRootCascade();

console.log(`Benchmark: ResourceRuntime (${DOMAIN_KEYS.length} linked domains, ${ITERATIONS} iterations, ${WARMUP} warm-up operations)`);
console.log("Timings are machine-relative; lower ms/op and higher ops/sec are better.\n");
for (const [name, measurement] of [
	["unchanged_reconcile", noOp],
	["leaf_replacement", leaf],
	["root_cascade_replacement", rootCascade],
] as const) {
	console.log(`METRIC ${name}_ms_per_op=${measurement.millisecondsPerOperation.toFixed(4)}`);
	console.log(`METRIC ${name}_ops_per_sec=${measurement.operationsPerSecond.toFixed(2)}`);
}
console.log(`ASI domains=${DOMAIN_KEYS.length} iterations=${ITERATIONS} warmup=${WARMUP}`);
