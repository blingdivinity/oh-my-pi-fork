import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { prompt, Snowflake } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import type { MCPManager } from "../mcp";
import backgroundTanDispatchPrompt from "../prompts/system/background-tan-dispatch.md" with { type: "text" };
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import * as sdk from "../sdk";
import type { AgentSession } from "../session/agent-session";
import { BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE } from "../session/messages";
import { SessionManager } from "../session/session-manager";
import { createMCPProxyTools, createSubagentSettings } from "./executor";

const TAN_LABEL_PREVIEW_LENGTH = 80;

function previewWork(work: string): string {
	const singleLine = work.trim().replace(/\s+/g, " ");
	if (singleLine.length <= TAN_LABEL_PREVIEW_LENGTH) return singleLine;
	return `${singleLine.slice(0, TAN_LABEL_PREVIEW_LENGTH - 1)}…`;
}

function extractAssistantText(message: AssistantMessage | undefined): string {
	if (!message) return "";
	return message.content
		.filter(content => content.type === "text")
		.map(content => content.text)
		.join("")
		.trim();
}

async function removeCloneSession(cloneFile: string): Promise<void> {
	await Promise.allSettled([
		fs.rm(cloneFile, { force: true }),
		fs.rm(cloneFile.slice(0, -6), { recursive: true, force: true }),
	]);
}

/**
 * Dependencies for {@link dispatchTangent}. `session` and `sessionManager` are
 * passed separately (in production they are the same session's manager) so the
 * TUI `/tan` controller and the web gateway can both supply their own handles.
 */
export interface DispatchTangentDeps {
	session: AgentSession;
	sessionManager: SessionManager;
	settings: Settings;
	mcpManager?: MCPManager;
}

export interface DispatchTangentResult {
	jobId: string;
}

/**
 * Spawn a background tangential agent (`/tan`) on a clone of the current session.
 * UI-agnostic orchestration shared by the interactive controller and the web
 * gateway: forks a suppressed clone, registers the background job, and appends
 * the dispatch breadcrumb. Throws on validation/setup failure (caller renders).
 */
export async function dispatchTangent(work: string, deps: DispatchTangentDeps): Promise<DispatchTangentResult> {
	const { session, sessionManager, settings, mcpManager } = deps;
	const trimmedWork = work.trim();
	if (!trimmedWork) throw new Error("Usage: /tan <work>");

	const model = session.model;
	if (!model) throw new Error("No active model available for /tan.");

	const manager = session.asyncJobManager;
	if (!manager) throw new Error("Background jobs are disabled; enable async jobs to use /tan.");

	const parentFile = sessionManager.getSessionFile();
	if (!parentFile) throw new Error("/tan requires a persisted session.");

	const parentSessionId = session.sessionId;
	const thinkingLevel = session.configuredThinkingLevel();
	const systemPrompt = [...session.systemPrompt];
	const toolNames = session.getActiveToolNames();
	const modelRegistry = session.modelRegistry;
	const ownerId = session.getAgentId() ?? MAIN_AGENT_ID;
	const cwd = sessionManager.getCwd();
	// Nest the clone inside the parent's artifact directory (like a subagent
	// session) rather than as a top-level sibling, so it shares the parent's
	// artifacts in place — no copy needed.
	const sessionDir = parentFile.slice(0, -6);
	const subagentSettings = createSubagentSettings(settings);
	const customTools = mcpManager ? createMCPProxyTools(mcpManager) : undefined;
	const enableLsp = settings.get("task.enableLsp") !== false;
	const agentRegistry = AgentRegistry.global();
	const cloneId = `Tan-${Snowflake.next()}`;
	const cloneFile = path.join(sessionDir, `${cloneId}.jsonl`);
	const label = `/tan ${previewWork(trimmedWork)}`;

	await sessionManager.ensureOnDisk();
	await sessionManager.flush();

	let jobId = "";
	try {
		const cloneManager = await SessionManager.forkFrom(parentFile, cwd, sessionDir, undefined, {
			suppressBreadcrumb: true,
			sessionFile: cloneFile,
		});

		jobId = manager.register(
			"task",
			label,
			async ({ signal }) => {
				if (signal.aborted) throw new Error("Aborted before execution");

				let clone: AgentSession | undefined;
				try {
					const created = await sdk.createAgentSession({
						cwd,
						sessionManager: cloneManager,
						model,
						thinkingLevel,
						systemPrompt,
						toolNames,
						providerSessionId: `${parentSessionId}:tan:${Snowflake.next()}`,
						providerPromptCacheKey: parentSessionId,
						modelRegistry,
						authStorage: modelRegistry.authStorage,
						settings: subagentSettings,
						hasUI: false,
						enableMCP: false,
						customTools,
						enableLsp,
						agentId: cloneId,
						agentDisplayName: "tan",
						parentTaskPrefix: cloneId,
						parentAgentId: ownerId,
						agentRegistry,
						disableExtensionDiscovery: true,
					});
					clone = created.session;
					const abortClone = () => {
						void clone?.abort();
					};
					signal.addEventListener("abort", abortClone, { once: true });
					try {
						if (signal.aborted) {
							abortClone();
							throw new Error("Aborted before execution");
						}
						await clone.prompt(trimmedWork, { attribution: "user" });
						await clone.waitForIdle();
						return extractAssistantText(clone.getLastAssistantMessage()) || "(no output)";
					} finally {
						signal.removeEventListener("abort", abortClone);
					}
				} finally {
					// Keep the finished tan in the Agent Hub instead of unregistering it:
					// flip the ref to parked BEFORE dispose so the sdk dispose wrapper
					// skips its unregister, then null the disposed session so the hub
					// treats it as a transcript-only parked agent. An aborted tan is
					// terminal — let dispose unregister it.
					if (clone) {
						if (signal.aborted) {
							agentRegistry.setStatus(cloneId, "aborted");
							await clone.dispose();
						} else {
							agentRegistry.setStatus(cloneId, "parked");
							await clone.dispose();
							agentRegistry.detachSession(cloneId);
						}
					}
				}
			},
			{ ownerId },
		);
	} catch (error) {
		if (cloneFile) await removeCloneSession(cloneFile);
		throw error instanceof Error ? error : new Error(String(error));
	}

	const content = prompt.render(backgroundTanDispatchPrompt, { jobId, work: trimmedWork });
	// /tan is meant to run alongside an active session. While the parent turn is
	// still streaming, queue the dispatch breadcrumb for the next turn rather than
	// steering the in-flight response; when idle this same call appends + persists
	// the entry immediately (identical to omitting deliverAs).
	await session.sendCustomMessage(
		{
			customType: BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE,
			content,
			display: true,
			attribution: "user",
			details: { jobId, work: trimmedWork, sessionFile: cloneFile },
		},
		{ triggerTurn: false, deliverAs: "nextTurn" },
	);
	return { jobId };
}
