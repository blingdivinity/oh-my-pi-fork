export interface ResourceNode<K extends string> {
	readonly key: K;
	readonly dependencies: readonly K[];
}

/**
 * Immutable dependency graph for reloadable resource domains.
 *
 * Registration order is used as the stable tie-breaker when independent nodes
 * can be prepared in either order. Dependencies always precede their consumers.
 */
export class ResourceGraph<K extends string> {
	readonly #nodes: ReadonlyMap<K, ResourceNode<K>>;
	readonly #orderedKeys: readonly K[];
	readonly #dependents: ReadonlyMap<K, readonly K[]>;

	constructor(nodes: readonly ResourceNode<K>[]) {
		const nodesByKey = new Map<K, ResourceNode<K>>();
		for (const node of nodes) {
			if (nodesByKey.has(node.key)) {
				throw new Error(`Duplicate resource domain: ${node.key}`);
			}
			nodesByKey.set(node.key, {
				key: node.key,
				dependencies: Object.freeze([...node.dependencies]),
			});
		}

		const dependents = new Map<K, K[]>();
		for (const key of nodesByKey.keys()) dependents.set(key, []);
		for (const node of nodesByKey.values()) {
			for (const dependency of node.dependencies) {
				if (!nodesByKey.has(dependency)) {
					throw new Error(`Resource domain ${node.key} depends on unknown domain ${dependency}`);
				}
				dependents.get(dependency)?.push(node.key);
			}
		}

		const visitState = new Map<K, "visiting" | "visited">();
		const visit = (key: K, path: readonly K[]): void => {
			const state = visitState.get(key);
			if (state === "visited") return;
			if (state === "visiting") {
				const cycleStart = path.indexOf(key);
				const cycle = [...path.slice(cycleStart), key];
				throw new Error(`Resource dependency cycle: ${cycle.join(" -> ")}`);
			}

			visitState.set(key, "visiting");
			const node = nodesByKey.get(key);
			if (!node) throw new Error(`Unknown resource domain: ${key}`);
			for (const dependency of node.dependencies) visit(dependency, [...path, key]);
			visitState.set(key, "visited");
		};
		for (const key of nodesByKey.keys()) visit(key, []);

		const registrationOrder = new Map<K, number>([...nodesByKey.keys()].map((key, index) => [key, index]));
		const remainingDependencies = new Map<K, number>(
			[...nodesByKey.values()].map(node => [node.key, node.dependencies.length]),
		);
		const ready = [...nodesByKey.keys()].filter(key => remainingDependencies.get(key) === 0);
		const ordered: K[] = [];
		while (ready.length > 0) {
			const key = ready.shift();
			if (key === undefined) continue;
			ordered.push(key);
			for (const dependent of dependents.get(key) ?? []) {
				const remaining = (remainingDependencies.get(dependent) ?? 0) - 1;
				remainingDependencies.set(dependent, remaining);
				if (remaining === 0) {
					ready.push(dependent);
					ready.sort((left, right) => (registrationOrder.get(left) ?? 0) - (registrationOrder.get(right) ?? 0));
				}
			}
		}

		this.#nodes = nodesByKey;
		this.#orderedKeys = Object.freeze(ordered);
		this.#dependents = new Map([...dependents].map(([key, values]) => [key, Object.freeze([...values])] as const));
	}

	get keys(): readonly K[] {
		return this.#orderedKeys;
	}

	has(key: K): boolean {
		return this.#nodes.has(key);
	}

	dependenciesOf(key: K): readonly K[] {
		return this.#getNode(key).dependencies;
	}

	dependentsOf(key: K): readonly K[] {
		this.#getNode(key);
		return this.#dependents.get(key) ?? [];
	}

	/** Return changed domains and all transitive consumers in dependency order. */
	affectedBy(changed: Iterable<K>): readonly K[] {
		const affected = new Set<K>();
		const queue: K[] = [];
		for (const key of changed) {
			this.#getNode(key);
			if (affected.has(key)) continue;
			affected.add(key);
			queue.push(key);
		}

		for (let index = 0; index < queue.length; index++) {
			const key = queue[index];
			if (key === undefined) continue;
			for (const dependent of this.#dependents.get(key) ?? []) {
				if (affected.has(dependent)) continue;
				affected.add(dependent);
				queue.push(dependent);
			}
		}

		return Object.freeze(this.#orderedKeys.filter(key => affected.has(key)));
	}

	/** Sort a domain subset so dependencies precede consumers. */
	order(keys: Iterable<K>): readonly K[] {
		const selected = new Set<K>();
		for (const key of keys) {
			this.#getNode(key);
			selected.add(key);
		}
		return Object.freeze(this.#orderedKeys.filter(key => selected.has(key)));
	}

	#getNode(key: K): ResourceNode<K> {
		const node = this.#nodes.get(key);
		if (!node) throw new Error(`Unknown resource domain: ${key}`);
		return node;
	}
}
