import { describe, expect, test } from "bun:test";
import {
	type ContributionResolverMap,
	ContributionStore,
	highestPriorityLatestWins,
	orderedCollection,
} from "../src/runtime/contribution-store";
import type { ScopeId } from "../src/runtime/resource-scope";

type Contributions = {
	tools: { readonly name: string };
	providers: { readonly id: string };
};

const owner = (value: string): ScopeId => value as ScopeId;

const resolvers: ContributionResolverMap<Contributions> = {
	tools: highestPriorityLatestWins(),
	providers: orderedCollection(),
};

function addTool(
	store: ContributionStore<Contributions>,
	name: string,
	metadata: { owner: ScopeId; sourceId: string; revision: number; priority?: number },
): void {
	store.add("tools", { ...metadata, key: "shared", value: { name } });
}

describe("ContributionStore", () => {
	test("keeps typed values, deterministic ordinals, and per-kind resolver policies", () => {
		const store = new ContributionStore(resolvers);
		addTool(store, "first", { owner: owner("one"), sourceId: "source-one", revision: 1, priority: 1 });
		addTool(store, "winner", { owner: owner("two"), sourceId: "source-two", revision: 1, priority: 5 });
		store.add("providers", {
			key: "shared",
			owner: owner("provider-one"),
			sourceId: "provider-source-one",
			revision: 1,
			value: { id: "first-provider" },
		});
		store.add("providers", {
			key: "shared",
			owner: owner("provider-two"),
			sourceId: "provider-source-two",
			revision: 1,
			value: { id: "second-provider" },
		});

		expect(store.list("tools", "shared").map(entry => [entry.value.name, entry.ordinal])).toEqual([
			["first", 0],
			["winner", 1],
		]);
		expect(store.resolve("tools", "shared")?.value?.name).toBe("winner");
		expect(store.resolve("providers", "shared")?.values.map(value => value.id)).toEqual([
			"first-provider",
			"second-provider",
		]);
	});

	test("restores shadowed candidates when an owner is removed", () => {
		const store = new ContributionStore(resolvers);
		addTool(store, "base", { owner: owner("base"), sourceId: "base-source", revision: 1, priority: 1 });
		addTool(store, "overlay", { owner: owner("overlay"), sourceId: "overlay-source", revision: 1, priority: 10 });
		expect(store.resolve("tools", "shared")?.value?.name).toBe("overlay");
		expect(store.removeOwner(owner("overlay"))).toBe(1);
		expect(store.resolve("tools", "shared")?.value?.name).toBe("base");
	});

	test("replaces same-owner source/key entries and removes the replacement", () => {
		const store = new ContributionStore(resolvers);
		addTool(store, "old", { owner: owner("owner"), sourceId: "source", revision: 1, priority: 1 });
		addTool(store, "new", { owner: owner("owner"), sourceId: "source", revision: 2, priority: 1 });
		expect(store.list("tools", "shared").map(entry => entry.value.name)).toEqual(["new"]);
		expect(store.removeOwner(owner("owner"))).toBe(1);
		expect(store.resolve("tools", "shared")).toBeUndefined();
	});

	test("preserves diagnostics and isolates published snapshots and candidates", () => {
		const diagnostic = { code: "shadowed", message: "candidate is shadowed", severity: "warning" as const };
		const store = new ContributionStore(resolvers);
		addTool(store, "first", { owner: owner("one"), sourceId: "source-one", revision: 1 });
		store.add("tools", {
			key: "shared",
			owner: owner("two"),
			sourceId: "source-two",
			revision: 1,
			diagnostics: [diagnostic],
			value: { name: "second" },
		});
		const resolution = store.resolve("tools", "shared");
		const snapshot = store.getSnapshot();
		const clone = ContributionStore.fromSnapshot(snapshot, resolvers);
		addTool(store, "later", { owner: owner("three"), sourceId: "source-three", revision: 1, priority: 20 });

		expect(resolution?.candidates).toHaveLength(2);
		expect(resolution?.diagnostics).toEqual([diagnostic]);
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot.entries.tools)).toBe(true);
		expect(clone.list("tools", "shared").map(entry => entry.value.name)).toEqual(["first", "second"]);
		clone.add("tools", {
			key: "new",
			owner: owner("clone"),
			sourceId: "clone-source",
			revision: 1,
			value: { name: "clone" },
		});
		expect(store.list("tools", "new")).toHaveLength(0);
		expect(clone.list("tools", "new")[0]?.ordinal).toBe(2);
	});

	test("removes matching candidates from one kind, including empty keys", () => {
		const store = new ContributionStore(resolvers);
		addTool(store, "base", { owner: owner("base"), sourceId: "base-source", revision: 1 });
		addTool(store, "overlay", { owner: owner("overlay"), sourceId: "overlay-source", revision: 1 });
		store.add("tools", {
			key: "only-overlay",
			owner: owner("overlay"),
			sourceId: "overlay-source",
			revision: 1,
			value: { name: "only overlay" },
		});
		store.add("providers", {
			key: "shared",
			owner: owner("provider"),
			sourceId: "overlay-source",
			revision: 1,
			value: { id: "provider" },
		});

		expect(store.removeWhere("tools", entry => entry.sourceId === "overlay-source")).toBe(2);
		expect(store.list("tools", "shared").map(entry => entry.value.name)).toEqual(["base"]);
		expect(store.resolve("tools", "only-overlay")).toBeUndefined();
		expect(store.list("providers", "shared").map(entry => entry.value.id)).toEqual(["provider"]);
		expect(
			store.add("tools", {
				key: "after-filter",
				owner: owner("new"),
				sourceId: "new-source",
				revision: 1,
				value: { name: "after filter" },
			}).ordinal,
		).toBe(4);
	});

	test("filters a clone from a snapshot without mutating the original snapshot", () => {
		const store = new ContributionStore(resolvers);
		addTool(store, "base", { owner: owner("base"), sourceId: "base-source", revision: 1 });
		addTool(store, "overlay", { owner: owner("overlay"), sourceId: "overlay-source", revision: 2 });
		store.add("providers", {
			key: "shared",
			owner: owner("provider"),
			sourceId: "provider-source",
			revision: 1,
			value: { id: "provider" },
		});
		const snapshot = store.getSnapshot();
		const clone = ContributionStore.fromSnapshot(snapshot, resolvers);

		expect(clone.removeWhere("tools", entry => entry.revision < 2)).toBe(1);
		expect(clone.list("tools", "shared").map(entry => entry.value.name)).toEqual(["overlay"]);
		expect(clone.list("providers", "shared").map(entry => entry.value.id)).toEqual(["provider"]);
		expect(store.list("tools", "shared").map(entry => entry.value.name)).toEqual(["base", "overlay"]);
		expect(snapshot.entries.tools.map(entry => entry.value.name)).toEqual(["base", "overlay"]);
		expect(snapshot.entries.providers.map(entry => entry.value.id)).toEqual(["provider"]);
	});
});
