/**
 * Web control protocol — the full-parity local web UI surface.
 *
 * The collab grammar in `./index.ts` (GuestFrame/HostFrame) covers session
 * REPLICATION (snapshot + entry/event/state/agents) plus basic steering
 * (prompt/abort/agent-cmd/fetch-transcript) over an E2E-encrypted relay. The
 * in-process local web server (`@oh-my-pi/pi-coding-agent` web mode) speaks the
 * SAME replication frames but adds the control surface a full UI needs — slash
 * commands, model/thinking/compaction control, tool approval, extension UI
 * dialogs, MCP status, and extension web panels.
 *
 * These frames are additive: a guest sends {@link WebControlFrame}s alongside
 * the collab {@link GuestFrame}s; the host answers with {@link WebControlEvent}s
 * alongside the collab {@link HostFrame}s. The collab relay never produces or
 * consumes them — they only flow on the local (same-origin, unsealed) transport
 * where the host advertises `control: true` in its {@link WebCapabilities}.
 *
 * Dependency-free JSON shapes, same boundary rules as `./index.ts`: cast at the
 * JSON edge and keep tolerant `default:` branches on every switch.
 */

import type { ImageContent } from "./index";

// ═══════════════════════════════════════════════════════════════════════════
// Capabilities (handshake)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Host → guest capability advertisement, sent once right after `welcome`. The
 * UI gates affordances on these flags so the SAME SPA can target a read-only
 * relay view, a full relay steer, or the local full-control server.
 */
export interface WebCapabilities {
	/** Mutating frames (prompt/abort/slash/model/…) are accepted. */
	canWrite: boolean;
	/** The richer {@link WebControlFrame} surface is available (local profile). */
	control: boolean;
	/** Named feature flags negotiated for forward-compat (e.g. "ext-panels"). */
	features: string[];
	/** Wire protocol version of the control surface. */
	proto: number;
}

/** Control-surface protocol version carried in {@link WebCapabilities}. */
export const WEB_CONTROL_PROTO = 1;

// ═══════════════════════════════════════════════════════════════════════════
// State projections (host → guest)
// ═══════════════════════════════════════════════════════════════════════════

/** Where a slash command came from (mirrors AvailableSlashCommandSource). */
export type WebSlashCommandSource = "builtin" | "skill" | "extension" | "custom" | "mcp_prompt" | "file";

/** A slash command the UI can present in its palette. */
export interface WebSlashCommand {
	name: string;
	description?: string;
	source: WebSlashCommandSource;
	/** Inline argument hint (e.g. "<subcommand>"). */
	argHint?: string;
	/** Subcommand names for completion (e.g. /mcp add, /mcp list). */
	subcommands?: string[];
}

/** A model the UI can switch to. */
export interface WebModelInfo {
	/** Stable selector "provider/modelId". */
	id: string;
	/** Bare provider model id (what `set-model` matches on; no routing suffix). */
	modelId: string;
	name: string;
	provider: string;
	contextWindow?: number | null;
	/** True for the session's active model. */
	current?: boolean;
}

/** MCP server connection status surfaced to the UI. */
export interface WebMcpServerStatus {
	name: string;
	status: "connected" | "connecting" | "disconnected";
	toolCount?: number;
	error?: string;
	scope?: string;
}

/** An option for an enum/submenu setting. */
export interface WebSettingOption {
	value: string;
	label: string;
}

/** A user-facing setting mirrored from the TUI settings menu (settings-defs). */
export interface WebSetting {
	path: string;
	tab: string;
	group?: string;
	label: string;
	description: string;
	kind: "boolean" | "enum" | "submenu" | "text";
	options?: WebSettingOption[];
	value: boolean | string;
}

/** A settings tab (group of settings) for the web settings panel. */
export interface WebSettingsTab {
	id: string;
	label: string;
	settings: WebSetting[];
}

/** A saved session the UI can resume / switch to. */
export interface WebSessionInfo {
	path: string;
	id: string;
	title?: string;
	firstMessage: string;
	messageCount: number;
	modified: number;
	current: boolean;
}

/** One section of the context window for the web /context panel. */
export interface WebContextCategory {
	label: string;
	tokens: number;
}

/** Context-window breakdown surfaced by the get-context control op. */
export interface WebContextBreakdown {
	contextWindow: number;
	usedTokens: number;
	freeTokens: number;
	percent: number;
	anchored: boolean;
	categories: WebContextCategory[];
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool approval (host → guest request, guest → host decision)
// ═══════════════════════════════════════════════════════════════════════════

export interface WebToolApprovalRequest {
	/** Correlates the request with a {@link WebControlFrame} `tool-approval` decision. */
	id: string;
	toolName: string;
	args: Record<string, unknown>;
	/** Extra lines from the tool's `formatApprovalDetails`. */
	details?: string[];
	/** Capability tier declared by the tool (e.g. "exec", "write"). */
	tier?: string;
}

export type WebToolApprovalDecision = "approve" | "deny" | "approve-always" | "deny-always";

// ═══════════════════════════════════════════════════════════════════════════
// Extension UI dialogs — transport-neutral mirror of the RPC extension-UI
// channel (the abstract ExtensionUIContext tier: select/confirm/input/…).
// ═══════════════════════════════════════════════════════════════════════════

export type WebExtUIRequest =
	| { id: string; method: "select"; title: string; options: string[]; timeout?: number }
	| { id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| { id: string; method: "input"; title: string; placeholder?: string; timeout?: number }
	| { id: string; method: "editor"; title: string; prefill?: string; timeout?: number; promptStyle?: boolean }
	| { id: string; method: "notify"; message: string; notifyType?: "info" | "warning" | "error" }
	| { id: string; method: "setStatus"; statusKey: string; statusText?: string }
	| { id: string; method: "setTitle"; title: string }
	| { id: string; method: "setWidget"; widgetKey: string; widgetLines?: string[]; widgetPlacement?: string }
	| { id: string; method: "set_editor_text"; text: string }
	| { id: string; method: "open_url"; url: string; instructions?: string }
	| { id: string; method: "cancel"; targetId: string };

export type WebExtUIResponse =
	| { id: string; value: string }
	| { id: string; confirmed: boolean }
	| { id: string; cancelled: true; timedOut?: boolean };

// ═══════════════════════════════════════════════════════════════════════════
// Extension web UI — Tier 1 (declarative nodes) and Tier 2 (sandboxed panels)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Tier 1: a serializable view tree an extension emits for a tool result or a
 * status surface. Rendered by TRUSTED host components in the SPA — no extension
 * code runs in the browser, so it is safe to broadcast to remote guests.
 */
export type WebUINode =
	| { t: "text"; text: string; tone?: "muted" | "error" | "success" | "warning" }
	| { t: "code"; code: string; lang?: string }
	| { t: "badge"; label: string; tone?: string }
	| { t: "row"; children: WebUINode[] }
	| { t: "col"; children: WebUINode[] }
	| { t: "kv"; pairs: { k: string; v: string }[] }
	| { t: "image"; data: string; mimeType: string }
	| { t: "link"; href: string; label: string }
	| { t: "table"; headers: string[]; rows: string[][] }
	| { t: "disclosure"; summary: string; children: WebUINode[]; open?: boolean };

/**
 * Tier 2: an extension-shipped browser artifact, mounted in a sandboxed iframe
 * (allow-scripts, no allow-same-origin) and addressed by a gateway-served URL.
 * Executable extension UI — local-profile only; never auto-broadcast to remote
 * guests.
 */
export interface WebExtPanel {
	id: string;
	extensionId: string;
	title: string;
	/** Gateway-served URL of the panel entry document mounted in the iframe. */
	src: string;
	placement?: "drawer" | "tab" | "overlay";
	/** Icon hint (lucide-react name) for tabs/drawers. */
	icon?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Guest → host control frames (require `canWrite`; gated to `control` hosts)
// ═══════════════════════════════════════════════════════════════════════════

export type WebControlFrame =
	/** Run a slash command line (e.g. "/model gpt-5", "/mcp list"). */
	| { t: "ctl"; op: "slash"; reqId: number; command: string }
	/** Free-form prompt with optional images (richer than collab `prompt`). */
	| {
			t: "ctl";
			op: "prompt";
			reqId: number;
			text: string;
			images?: ImageContent[];
			streamingBehavior?: "steer" | "followUp";
	  }
	| { t: "ctl"; op: "steer"; reqId: number; text: string; images?: ImageContent[] }
	| { t: "ctl"; op: "follow-up"; reqId: number; text: string; images?: ImageContent[] }
	| { t: "ctl"; op: "abort"; reqId: number }
	| { t: "ctl"; op: "set-model"; reqId: number; provider: string; modelId: string }
	| { t: "ctl"; op: "cycle-model"; reqId: number; direction?: "forward" | "backward" }
	| { t: "ctl"; op: "set-thinking"; reqId: number; level: string }
	| { t: "ctl"; op: "cycle-thinking"; reqId: number }
	| { t: "ctl"; op: "compact"; reqId: number; instructions?: string }
	| { t: "ctl"; op: "set-session-name"; reqId: number; name: string }
	| { t: "ctl"; op: "branch"; reqId: number; entryId: string }
	| { t: "ctl"; op: "bash"; reqId: number; command: string }
	| { t: "ctl"; op: "abort-bash"; reqId: number }
	| { t: "ctl"; op: "retry"; reqId: number }
	| { t: "ctl"; op: "list-sessions"; reqId: number }
	| { t: "ctl"; op: "switch-session"; reqId: number; path: string }
	| {
			t: "ctl";
			op: "goal";
			reqId: number;
			action: "set" | "pause" | "resume" | "drop" | "budget";
			objective?: string;
			budget?: number | null;
	  }
	| { t: "ctl"; op: "get-context"; reqId: number }
	| { t: "ctl"; op: "get-models"; reqId: number }
	| { t: "ctl"; op: "get-commands"; reqId: number }
	| { t: "ctl"; op: "get-mcp"; reqId: number }
	| { t: "ctl"; op: "get-settings"; reqId: number }
	| { t: "ctl"; op: "set-setting"; reqId: number; path: string; value: boolean | string }
	| { t: "ctl"; op: "tool-approval"; reqId: number; approvalId: string; decision: WebToolApprovalDecision }
	/** Reply to a {@link WebExtUIRequest}. */
	| { t: "ext-ui-response"; response: WebExtUIResponse }
	/** Message from a sandboxed extension panel to its host-side extension. */
	| { t: "ext-panel-message"; panelId: string; data: unknown };

// ═══════════════════════════════════════════════════════════════════════════
// Host → guest control event frames
// ═══════════════════════════════════════════════════════════════════════════

export type WebControlEvent =
	/** Per-{@link WebControlFrame} acknowledgement keyed by `reqId`. */
	| { t: "ctl-ack"; reqId: number; ok: true; data?: unknown }
	| { t: "ctl-ack"; reqId: number; ok: false; error: string }
	/** Capability handshake (after `welcome`). */
	| { t: "capabilities"; capabilities: WebCapabilities }
	| { t: "commands"; commands: WebSlashCommand[] }
	| { t: "models"; models: WebModelInfo[] }
	| { t: "mcp"; servers: WebMcpServerStatus[] }
	| { t: "settings"; settings: WebSettingsTab[] }
	/** Output text from a slash command run (e.g. /help, /mcp list). */
	| { t: "command-output"; text: string }
	| { t: "tool-approval-request"; request: WebToolApprovalRequest }
	| { t: "tool-approval-cancel"; approvalId: string }
	| { t: "ext-ui-request"; request: WebExtUIRequest }
	/** Full set of currently registered extension panels (Tier 2). */
	| { t: "ext-panels"; panels: WebExtPanel[] }
	/** Message from a host-side extension to its sandboxed panel. */
	| { t: "ext-panel-message"; panelId: string; data: unknown };

/** Everything a local-profile guest may send. */
export type WebGuestMessage = WebControlFrame;
/** Everything a local-profile host may send beyond the collab HostFrame set. */
export type WebHostMessage = WebControlEvent;
