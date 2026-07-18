import { describe, expect, test, vi } from "bun:test";
import { ResourceScopeRevokedError, ScopeManager } from "../src/runtime/resource-scope";

function source(id: string) {
	return { id, kind: "test" } as const;
}

async function isSettled(promise: Promise<unknown>): Promise<boolean> {
	return Promise.race([
		promise.then(
			() => true,
			() => true,
		),
		Promise.resolve(false),
	]);
}

describe("ScopeManager", () => {
	test("recursively revokes descendants and rejects stale actions", () => {
		const manager = new ScopeManager("session");
		const root = manager.create({ source: source("root") });
		const child = manager.create({ parent: root.id, source: source("child"), revision: 2 });
		const grandchild = manager.create({ parent: child.id, source: source("grandchild") });

		expect(manager.childrenOf(root.id)).toEqual([
			expect.objectContaining({ id: child.id, parent: root.id, revision: 2 }),
		]);
		expect(manager.revoke(child.id)).toEqual([child.id, grandchild.id]);
		expect(() => manager.assertLive(root.id)).not.toThrow();
		expect(() => manager.assertLive(child.id)).toThrow(ResourceScopeRevokedError);
		expect(() => manager.acquire(grandchild.id)).toThrow(ResourceScopeRevokedError);
		expect(() => manager.create({ parent: child.id, source: source("late") })).toThrow(ResourceScopeRevokedError);
	});

	test("waits for all subtree pins and releases pins idempotently", async () => {
		const manager = new ScopeManager();
		const root = manager.create({ source: source("root") });
		const child = manager.create({ parent: root.id, source: source("child") });
		const rootPin = manager.acquire(root.id);
		const childPin = manager.acquire(child.id);
		const drained = manager.waitForIdle(root.id);

		expect(await isSettled(drained)).toBe(false);
		rootPin.release();
		rootPin.release();
		expect(await isSettled(drained)).toBe(false);
		childPin.release();
		await drained;
		expect(rootPin.released).toBe(true);
		expect(childPin.released).toBe(true);
	});

	test("disposes descendants first and registrations in reverse order exactly once", async () => {
		const manager = new ScopeManager();
		const order: string[] = [];
		const root = manager.create({ source: source("root") });
		const child = manager.create({ parent: root.id, source: source("child") });
		manager.track(root.id, () => {
			order.push("root:first");
		});
		manager.track(root.id, () => {
			order.push("root:second");
		});
		manager.track(child.id, () => {
			order.push("child:first");
		});
		manager.track(child.id, () => {
			order.push("child:second");
		});

		const first = manager.dispose(root.id, 100);
		const second = manager.dispose(root.id, 100);
		expect(second).toBe(first);
		const report = await first;

		expect(order).toEqual(["child:second", "child:first", "root:second", "root:first"]);
		expect(report).toEqual({ scopes: [child.id, root.id], invoked: 4, errors: [], timedOut: false });
		expect(manager.get(root.id)).toEqual(expect.objectContaining({ revoked: true, disposed: true }));
	});

	test("reports throwing and deadline-bound cleanup without reinvoking it", async () => {
		vi.useFakeTimers();
		try {
			const manager = new ScopeManager();
			const root = manager.create({ source: source("root") });
			let throwingCalls = 0;
			let hangingCalls = 0;
			manager.track(root.id, () => {
				throwingCalls++;
				throw new Error("cleanup failed");
			});
			manager.track(root.id, async signal => {
				hangingCalls++;
				const aborted = Promise.withResolvers<void>();
				if (signal.aborted) aborted.resolve();
				else signal.addEventListener("abort", () => aborted.resolve(), { once: true });
				await aborted.promise;
			});

			const disposal = manager.dispose(root.id, 5);
			await Promise.resolve();
			vi.advanceTimersByTime(5);
			const report = await disposal;
			expect(report.timedOut).toBe(true);
			expect(report.invoked).toBe(2);
			expect(report.errors).toHaveLength(1);
			expect(report.errors[0]?.scope).toBe(root.id);
			expect((report.errors[0]!.cause as Error).message).toBe("cleanup failed");

			await manager.dispose(root.id, 100);
			expect(throwingCalls).toBe(1);
			expect(hangingCalls).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	test("aborts an idle wait without affecting live pins", async () => {
		const manager = new ScopeManager();
		const root = manager.create({ source: source("root") });
		const pin = manager.acquire(root.id);
		const controller = new AbortController();
		const waiting = manager.waitForIdle(root.id, controller.signal);
		controller.abort(new Error("cancelled"));
		await expect(waiting).rejects.toThrow("cancelled");
		expect(pin.released).toBe(false);
		pin.release();
	});
	test("unlinks disposed children and bounds lightweight tombstones", async () => {
		const manager = new ScopeManager("bounded");
		const root = manager.create({ source: source("root") });
		const disposed: string[] = [];

		for (let index = 0; index < 300; index++) {
			const child = manager.create({ parent: root.id, source: source(`child-${index}`) });
			disposed.push(child.id);
			await manager.dispose(child.id, 100);
		}

		expect(manager.childrenOf(root.id)).toEqual([]);
		expect(manager.get(disposed.at(-1)! as typeof root.id)).toEqual(
			expect.objectContaining({ revoked: true, disposed: true }),
		);
		expect(manager.get(disposed[0]! as typeof root.id)).toBeUndefined();
		await manager.dispose(root.id, 100);
	});
});
