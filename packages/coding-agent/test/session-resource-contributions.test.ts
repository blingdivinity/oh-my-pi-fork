import { describe, expect, it } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import {
	SESSION_TOOL_CONTRIBUTION_PRIORITY,
	SessionResourceContributions,
} from "@oh-my-pi/pi-coding-agent/session/session-resource-contributions";
import { type } from "arktype";

function createTool(name: string, label: string): AgentTool {
	return {
		name,
		label,
		description: label,
		parameters: type({}),
		async execute() {
			return { content: [{ type: "text" as const, text: label }] };
		},
	};
}

describe("SessionResourceContributions", () => {
	it("resolves source precedence and policy exclusions into the effective tool registry", async () => {
		const contributions = new SessionResourceContributions({
			source: { kind: "session", id: "precedence-test" },
		});
		const builtinRead = createTool("read", "Built-in read");
		const pendingRead = createTool("read", "Pending MCP read");
		const extensionRead = createTool("read", "Extension read");
		const builtinEdit = createTool("edit", "Built-in edit");

		contributions.addTool(builtinRead, {
			source: { kind: "builtin-tool", id: "builtin" },
			priority: SESSION_TOOL_CONTRIBUTION_PRIORITY.builtin,
		});
		contributions.addTool(pendingRead, {
			source: { kind: "mcp-tool", id: "pending" },
			priority: SESSION_TOOL_CONTRIBUTION_PRIORITY.pending,
		});
		contributions.addTool(extensionRead, {
			source: { kind: "extension", id: "test-extension" },
			priority: SESSION_TOOL_CONTRIBUTION_PRIORITY.extension,
		});
		contributions.addTool(builtinEdit, {
			source: { kind: "builtin-tool", id: "builtin" },
			priority: SESSION_TOOL_CONTRIBUTION_PRIORITY.builtin,
		});
		contributions.excludeTool("edit", {
			source: { kind: "tool-policy", id: "cursor" },
			priority: SESSION_TOOL_CONTRIBUTION_PRIORITY.policy,
		});

		const registry = contributions.resolveToolRegistry();
		expect(registry.get("read")).toBe(extensionRead);
		expect(registry.has("edit")).toBe(false);
		expect(
			contributions
				.resolveTools()
				.get("read")
				?.candidates.map(candidate => candidate.value),
		).toEqual([builtinRead, pendingRead, extensionRead]);
		expect(contributions.snapshot.entries.tool).toHaveLength(5);

		await contributions.dispose();
		expect(contributions.scopes.get(contributions.sessionScope)?.disposed).toBe(true);
	});
});
