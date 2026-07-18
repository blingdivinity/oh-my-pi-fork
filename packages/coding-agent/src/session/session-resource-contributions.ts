import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import {
	type ContributionDiagnostic,
	type ContributionResolution,
	type ContributionSnapshot,
	ContributionStore,
	highestPriorityLatestWins,
} from "../runtime/contribution-store";
import { type CleanupReport, type ResourceSource, type ScopeId, ScopeManager } from "../runtime/resource-scope";

export interface SessionContributionMap {
	readonly tool: AgentTool | null;
}

export type SessionContributionState = ContributionSnapshot<SessionContributionMap>;
export type SessionToolResolution = ContributionResolution<SessionContributionMap["tool"]>;

export const SESSION_TOOL_CONTRIBUTION_PRIORITY = Object.freeze({
	pending: -100,
	builtin: 0,
	extension: 100,
	runtime: 200,
	policy: 1_000,
});

export interface SessionContributionSource {
	readonly source: ResourceSource;
	readonly sourceId?: string;
	readonly revision?: number;
	readonly priority?: number;
	readonly diagnostics?: readonly ContributionDiagnostic[];
}

export interface CreateSessionResourceContributionsOptions {
	readonly source: ResourceSource;
	readonly revision?: number;
	readonly idPrefix?: string;
	readonly scopes?: ScopeManager;
}

/**
 * Builds contribution candidates under session-owned scopes before the first
 * immutable resource manifest is published. The same scopes and snapshot are
 * transferred into SessionResourceController, so startup and reload resolution
 * share one precedence and ownership model.
 */
export class SessionResourceContributions {
	readonly scopes: ScopeManager;
	readonly sessionScope: ScopeId;
	readonly #store = new ContributionStore<SessionContributionMap>({
		tool: highestPriorityLatestWins(),
	});
	readonly #owners = new Map<string, ScopeId>();

	constructor(options: CreateSessionResourceContributionsOptions) {
		this.scopes = options.scopes ?? new ScopeManager(options.idPrefix ?? "session-resource");
		this.sessionScope = this.scopes.create({
			source: options.source,
			revision: options.revision ?? 1,
		}).id;
	}

	addTool(tool: AgentTool, input: SessionContributionSource): void {
		this.#addToolValue(tool.name, tool, input);
	}

	excludeTool(name: string, input: SessionContributionSource): void {
		this.#addToolValue(name, null, input);
	}

	resolveTools(): ReadonlyMap<string, SessionToolResolution> {
		return this.#store.resolveAll("tool");
	}

	resolveToolRegistry(): Map<string, AgentTool> {
		const registry = new Map<string, AgentTool>();
		for (const [name, resolution] of this.resolveTools()) {
			if (resolution.winner?.value) registry.set(name, resolution.winner.value);
		}
		return registry;
	}

	get snapshot(): SessionContributionState {
		return this.#store.getSnapshot();
	}

	dispose(timeoutMs?: number): Promise<CleanupReport> {
		return this.scopes.dispose(this.sessionScope, timeoutMs);
	}

	#addToolValue(name: string, value: AgentTool | null, input: SessionContributionSource): void {
		const revision = input.revision ?? 1;
		this.#store.add("tool", {
			key: name,
			owner: this.#owner(input.source, revision),
			sourceId: input.sourceId ?? input.source.id,
			revision,
			priority: input.priority,
			diagnostics: input.diagnostics,
			value,
		});
	}

	#owner(source: ResourceSource, revision: number): ScopeId {
		const identity = `${source.kind}\u0000${source.id}\u0000${source.path ?? ""}\u0000${revision}`;
		const existing = this.#owners.get(identity);
		if (existing) return existing;
		const owner = this.scopes.create({
			parent: this.sessionScope,
			source,
			revision,
		}).id;
		this.#owners.set(identity, owner);
		return owner;
	}
}
