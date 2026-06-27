/**
 * Pure projections from Layer-1 state to web control-protocol shapes. No
 * transport, no side effects — just shape adapters consumed by the gateway.
 */

import type { Model } from "@oh-my-pi/pi-ai";
import type { SessionTodoPhase } from "@oh-my-pi/pi-wire";
import type { WebContextBreakdown, WebMcpServerStatus, WebModelInfo, WebSlashCommand } from "@oh-my-pi/pi-wire/web";
import { formatModelString } from "../config/model-resolver";
import type { MCPManager } from "../mcp";
import type { ContextUsageBreakdown } from "../session/agent-session";
import type { InternalAvailableSlashCommand } from "../slash-commands/available-commands";
import type { TodoPhase } from "../tools/todo";

/** Project the available-commands list into the wire palette shape. */
export function toWebSlashCommands(commands: readonly InternalAvailableSlashCommand[]): WebSlashCommand[] {
	return commands.map(command => ({
		name: command.name,
		description: command.description,
		source: command.source,
		argHint: command.input?.hint,
		subcommands: command.subcommands?.map(sub => sub.name),
	}));
}

/** Project available models + the active model into the wire model shape. */
export function toWebModels(models: readonly Model[], current: Model | undefined): WebModelInfo[] {
	const currentId = current ? formatModelString(current) : undefined;
	return models.map(model => {
		const id = formatModelString(model);
		return {
			id,
			modelId: model.id,
			name: model.name,
			provider: model.provider,
			contextWindow: model.contextWindow,
			current: id === currentId,
		};
	});
}

/**
 * Build a full MCP status snapshot from the manager. The manager only exposes
 * per-server status accessors (no aggregate), so we fold its three name sets.
 */
export function toWebMcpStatus(manager: MCPManager | undefined): WebMcpServerStatus[] {
	if (!manager) return [];
	const tools = manager.getTools();
	const names = manager.getAllServerNames();
	return names.map(name => {
		const status = manager.getConnectionStatus(name);
		const toolCount = status === "connected" ? tools.filter(tool => tool.mcpServerName === name).length : undefined;
		return { name, status, toolCount };
	});
}

/** Project the agent's todo phases into the wire snapshot shape (drop empty phases). */
export function toWebTodos(phases: readonly TodoPhase[]): SessionTodoPhase[] {
	return phases
		.filter(phase => phase.tasks.length > 0)
		.map(phase => ({
			name: phase.name,
			tasks: phase.tasks.map(task => ({ content: task.content, status: task.status })),
		}));
}

/** Project a context-usage breakdown into the web /context panel shape. */
export function toWebContextBreakdown(b: ContextUsageBreakdown): WebContextBreakdown {
	const win = b.contextWindow;
	return {
		contextWindow: win,
		usedTokens: b.usedTokens,
		freeTokens: Math.max(0, win - b.usedTokens),
		percent: win > 0 ? (b.usedTokens / win) * 100 : 0,
		anchored: b.anchored,
		categories: [
			{ label: "System prompt", tokens: b.systemPromptTokens },
			{ label: "Tools", tokens: b.systemToolsTokens },
			{ label: "Context", tokens: b.systemContextTokens },
			{ label: "Skills", tokens: b.skillsTokens },
			{ label: "Messages", tokens: b.messagesTokens },
		],
	};
}
