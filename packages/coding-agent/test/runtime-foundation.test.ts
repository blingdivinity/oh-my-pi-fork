import { describe, expect, test } from "bun:test";
import { ResourceGraph } from "../src/runtime/resource-graph";
import { AdmissionPermit, ReloadAdmissionGate, RuntimeLeaseManager } from "../src/runtime/runtime-lease";
import { createRuntimeManifest, type ResourceSnapshotMap } from "../src/runtime/runtime-manifest";

async function settles<T>(promise: Promise<T>): Promise<boolean> {
	return Promise.race([
		promise.then(
			() => true,
			() => true,
		),
		Promise.resolve(false),
	]);
}

describe("ResourceGraph", () => {
	test("orders dependencies first and invalidates transitive consumers", () => {
		const graph = new ResourceGraph([
			{ key: "ui", dependencies: ["config"] },
			{ key: "plugin", dependencies: ["base"] },
			{ key: "base", dependencies: [] },
			{ key: "config", dependencies: ["base"] },
		]);

		expect(graph.keys).toEqual(["base", "plugin", "config", "ui"]);
		expect(graph.order(["ui", "base"])).toEqual(["base", "ui"]);
		expect(graph.affectedBy(["base"])).toEqual(["base", "plugin", "config", "ui"]);
		expect(graph.affectedBy(["config"])).toEqual(["config", "ui"]);
		const stable = new ResourceGraph([
			{ key: "a", dependencies: ["c"] },
			{ key: "b", dependencies: ["d"] },
			{ key: "c", dependencies: [] },
			{ key: "d", dependencies: [] },
		]);
		expect(stable.keys).toEqual(["c", "a", "d", "b"]);
	});

	test("preserves empty domain keys during transitive invalidation", () => {
		const graph = new ResourceGraph([
			{ key: "child", dependencies: [""] },
			{ key: "", dependencies: [] },
		]);

		expect(graph.affectedBy([""])).toEqual(["", "child"]);
	});

	test("rejects cycles, missing dependencies, and unknown query domains", () => {
		expect(
			() =>
				new ResourceGraph([
					{ key: "a", dependencies: ["b"] },
					{ key: "b", dependencies: ["a"] },
				]),
		).toThrow("Resource dependency cycle: a -> b -> a");
		expect(() => new ResourceGraph([{ key: "a", dependencies: ["missing"] }])).toThrow(
			"depends on unknown domain missing",
		);

		const graph = new ResourceGraph<string>([{ key: "a", dependencies: [] }]);
		expect(() => graph.affectedBy(["missing"])).toThrow("Unknown resource domain: missing");
		expect(() => graph.dependenciesOf("missing")).toThrow("Unknown resource domain: missing");
	});
});

type Resources = {
	core: string;
	ui: number;
};

describe("RuntimeManifest", () => {
	test("publishes an aggregate with independent revision vectors and frozen top-level views", () => {
		const resources: ResourceSnapshotMap<Resources> = {
			core: { revision: 4, fingerprint: "core-v4", value: "core", owners: [] },
			ui: { revision: 9, fingerprint: "ui-v9", value: 7, owners: [] },
		};
		const contributions = { enabled: true };
		const effective = { core: "effective-core" };
		const manifest = createRuntimeManifest<Resources, typeof contributions, typeof effective>({
			id: 12,
			desiredRevision: 8,
			resources,
			contributions,
			effective,
			publishedAt: 0,
		});

		expect(manifest.id).toBe(12);
		expect(manifest.desiredRevision).toBe(8);
		expect(manifest.publishedAt).toBe(0);
		expect(manifest.appliedRevisions).toEqual({ core: 4, ui: 9 });
		expect(manifest.contributions).toBe(contributions);
		expect(manifest.effective).toBe(effective);
		expect(manifest.resources.core).toBe(resources.core);
		expect(Object.isFrozen(manifest)).toBe(true);
		expect(Object.isFrozen(manifest.resources)).toBe(true);
		expect(Object.isFrozen(manifest.appliedRevisions)).toBe(true);

		const mutableResources = resources as unknown as Record<string, unknown>;
		mutableResources.core = { revision: 99 };
		delete mutableResources.ui;
		expect(manifest.resources.core.revision).toBe(4);
		expect(manifest.resources.ui.revision).toBe(9);
		expect(Reflect.set(manifest as unknown as Record<string, unknown>, "id", 99)).toBe(false);
	});
});

describe("RuntimeLeaseManager", () => {
	test("deduplicates targets and releases each lease idempotently", () => {
		const manager = new RuntimeLeaseManager();
		const target = { kind: "manifest" as const, revision: 3 };
		const lease = manager.acquire([target, target, { ...target }]);

		expect(lease.targets).toEqual([target]);
		expect(manager.count(target)).toBe(1);
		expect(lease.released).toBe(false);
		lease.release();
		lease.release();
		expect(lease.released).toBe(true);
		expect(manager.count(target)).toBe(0);
	});

	test("drains only selected targets and rejects an aborted drain", async () => {
		const manager = new RuntimeLeaseManager();
		const target = { kind: "manifest" as const, revision: 1 };
		const other = { kind: "manifest" as const, revision: 2 };
		const targetLease = manager.acquire(target);
		const otherLease = manager.acquire(other);

		const targeted = manager.drain(target);
		expect(await settles(targeted)).toBe(false);
		targetLease.release();
		await targeted;
		expect(manager.count(other)).toBe(1);

		const controller = new AbortController();
		const reason = new Error("cancel drain");
		const aborted = manager.drain(other, controller.signal);
		controller.abort(reason);
		await expect(aborted).rejects.toBe(reason);
		otherLease.release();
	});
});

describe("ReloadAdmissionGate", () => {
	test("closes before queued admission, drains across reopen, and tolerates repeated transitions", async () => {
		const gate = new ReloadAdmissionGate();
		const active = await gate.admit();
		const closing = gate.close();
		const queued = gate.admit();

		expect(gate.isOpen).toBe(false);
		expect(gate.activePermits).toBe(1);
		expect(await settles(queued)).toBe(false);

		gate.open();
		const queuedPermit = await queued;
		expect(gate.isOpen).toBe(true);
		expect(gate.activePermits).toBe(2);
		active.release();
		expect(await settles(closing)).toBe(false);
		queuedPermit.release();
		await closing;
		expect(gate.activePermits).toBe(0);

		const second = await gate.admit();
		const secondClose = gate.close();
		expect(gate.close()).toBe(secondClose);
		gate.open();
		gate.open();
		second.release();
		await secondClose;
		expect(gate.isOpen).toBe(true);

		const held = await gate.admit();
		const pendingClose = gate.close();
		gate.open();
		const reopenedPermit = await gate.admit();
		expect(gate.close()).toBe(pendingClose);
		held.release();
		reopenedPermit.release();
		await pendingClose;
		expect(gate.isOpen).toBe(false);
		gate.open();

		const thirdClose = gate.close();
		await thirdClose;
		gate.open();
	});

	test("aborts queued admission and makes permits idempotent", async () => {
		const gate = new ReloadAdmissionGate();
		const preAborted = new AbortController();
		const preAbortedReason = new Error("already cancelled");
		preAborted.abort(preAbortedReason);
		await expect(gate.admit(preAborted.signal)).rejects.toBe(preAbortedReason);

		gate.close();
		const controller = new AbortController();
		const reason = new Error("cancel admission");
		const admission = gate.admit(controller.signal);
		controller.abort(reason);
		await expect(admission).rejects.toBe(reason);
		gate.open();

		const permit = await gate.admit();
		expect(permit).toBeInstanceOf(AdmissionPermit);
		expect(gate.activePermits).toBe(1);
		permit.release();
		permit.release();
		expect(permit.released).toBe(true);
		expect(gate.activePermits).toBe(0);
	});
});
