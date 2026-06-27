import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import type { LocalClient, LocalSnapshot } from "../../lib/local-client";

const MODEL_MENU_CMDS = new Set(["model", "models", "switch"]);

const HISTORY_KEY = "omp.web.history";
function loadHistory(): string[] {
	try {
		const raw = localStorage.getItem(HISTORY_KEY);
		const parsed = raw ? JSON.parse(raw) : [];
		return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
	} catch {
		return [];
	}
}
function saveHistory(list: string[]): void {
	try {
		localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
	} catch {
		// localStorage unavailable — history is best-effort
	}
}

interface LocalComposerProps {
	client: LocalClient;
	snapshot: LocalSnapshot;
	/** Open the model picker overlay for /model, /models, /switch. */
	onOpenModelPicker?: () => void;
	/** Open the settings panel for /settings. */
	onOpenSettings?: () => void;
	/** Open the hotkeys reference for /hotkeys. */
	onOpenHotkeys?: () => void;
	/** Open the session picker for /resume. */
	onOpenSessions?: () => void;
	/** Open the goal panel for /goal. */
	onOpenGoal?: () => void;
	/** Open the context panel for /context. */
	onOpenContext?: () => void;
	/** Open the session-tree overlay for /tree. */
	onOpenTree?: () => void;
	/** Open the agents rail for /agents. */
	onOpenAgents?: () => void;
	/** Export the session to HTML (browser download) for /export. */
	onExport?: () => void;
	/** Toggle client-side loop mode for /loop. */
	onToggleLoop?: () => void;
	/** Called with each free-text prompt sent (loop re-submit + history). */
	onPromptSent?: (text: string) => void;
	/** Open the omfg rule-forge modal for /omfg (with optional prefilled complaint). */
	onOpenOmfg?: (complaint: string) => void;
	/** Open the extensions panel for /extensions (alias /status). */
	onOpenExtensions?: () => void;
}

export function LocalComposer({
	client,
	snapshot,
	onOpenModelPicker,
	onOpenSettings,
	onOpenHotkeys,
	onOpenSessions,
	onOpenGoal,
	onOpenContext,
	onOpenTree,
	onOpenAgents,
	onExport,
	onToggleLoop,
	onPromptSent,
	onOpenOmfg,
	onOpenExtensions,
}: LocalComposerProps): ReactNode {
	const [text, setText] = useState("");
	const [activeSlash, setActiveSlash] = useState(0);
	const readOnly = snapshot.readOnly;
	const [promptHistory, setPromptHistory] = useState<string[]>(() => loadHistory());
	const [historyOpen, setHistoryOpen] = useState(false);
	const [historyIdx, setHistoryIdx] = useState(0);
	const tryLocalUi = (name: string): boolean => {
		const cmd = name.toLowerCase();
		if (onOpenModelPicker && MODEL_MENU_CMDS.has(cmd)) {
			onOpenModelPicker();
			return true;
		}
		if (onOpenSettings && cmd === "settings") {
			onOpenSettings();
			return true;
		}
		if (onOpenHotkeys && cmd === "hotkeys") {
			onOpenHotkeys();
			return true;
		}
		if (onOpenSessions && cmd === "resume") {
			onOpenSessions();
			return true;
		}
		if (onOpenGoal && (cmd === "goal" || cmd === "guided-goal")) {
			onOpenGoal();
			return true;
		}
		if (onOpenContext && cmd === "context") {
			onOpenContext();
			return true;
		}
		if (onOpenTree && cmd === "tree") {
			onOpenTree();
			return true;
		}
		if (onOpenAgents && cmd === "agents") {
			onOpenAgents();
			return true;
		}
		if (onOpenOmfg && cmd === "omfg") {
			onOpenOmfg("");
			return true;
		}
		if (onOpenExtensions && (cmd === "extensions" || cmd === "status")) {
			onOpenExtensions();
			return true;
		}
		if (onExport && cmd === "export") {
			onExport();
			return true;
		}
		if (onToggleLoop && cmd === "loop") {
			onToggleLoop();
			return true;
		}
		return false;
	};

	const slashMatches = useMemo(() => {
		// Only while still typing the command name (no space/args yet).
		if (!text.startsWith("/") || text.includes(" ")) return [];
		const token = text.slice(1).toLowerCase();
		return snapshot.commands.filter(c => c.name.toLowerCase().startsWith(token)).slice(0, 8);
	}, [text, snapshot.commands]);
	const historyMatches = useMemo(
		() => (historyOpen ? promptHistory.filter(h => h.toLowerCase().includes(text.toLowerCase())).slice(0, 8) : []),
		[historyOpen, promptHistory, text],
	);

	const submit = (behavior: "steer" | "followUp" = "steer"): void => {
		const value = text.trim();
		if (!value || readOnly) return;
		const lower = value.toLowerCase();
		if (onOpenOmfg && (lower === "/omfg" || lower.startsWith("/omfg "))) {
			onOpenOmfg(value.slice("/omfg".length).trim());
		} else if (value.startsWith("/")) {
			const [head, ...rest] = value.slice(1).split(/\s+/);
			if (rest.length > 0 || !tryLocalUi(head ?? "")) void client.runSlash(value);
		} else {
			void client.prompt(value, behavior);
			onPromptSent?.(value);
		}
		setPromptHistory(h => {
			const next = [value, ...h.filter(x => x !== value)].slice(0, 100);
			saveHistory(next);
			return next;
		});
		setText("");
		setActiveSlash(0);
		setHistoryOpen(false);
	};

	const applySlash = (name: string): void => {
		setText(`/${name} `);
		setActiveSlash(0);
	};
	const runSlashName = (name: string): void => {
		if (readOnly) return;
		if (!tryLocalUi(name)) void client.runSlash(`/${name}`);
		setText("");
		setActiveSlash(0);
	};

	const currentModel = snapshot.models.find(m => m.current);
	const connectedMcp = snapshot.mcp.filter(s => s.status === "connected").length;

	return (
		<div className="lc-composer">
			<div className="lc-controls">
				<select
					value={currentModel?.id ?? ""}
					disabled={readOnly || snapshot.models.length === 0}
					onChange={e => {
						const info = snapshot.models.find(m => m.id === e.target.value);
						if (info) void client.setModel(info.provider, info.modelId);
					}}
				>
					{snapshot.models.length === 0 && <option value="">no models</option>}
					{snapshot.models.map(m => (
						<option key={m.id} value={m.id}>
							{m.provider}/{m.name}
						</option>
					))}
				</select>
				<button type="button" disabled={readOnly} onClick={() => void client.cycleThinking()}>
					thinking: {snapshot.state?.thinkingLevel ?? "default"}
				</button>
				{snapshot.mcp.length > 0 && (
					<span className="lc-badge">
						MCP {connectedMcp}/{snapshot.mcp.length}
					</span>
				)}
				{snapshot.state?.contextUsage?.percent != null && (
					<span className="lc-badge">ctx {Math.round(snapshot.state.contextUsage.percent)}%</span>
				)}
				{readOnly && <span className="lc-badge">read-only</span>}
			</div>
			<div className="lc-input-row">
				{slashMatches.length > 0 && (
					<div className="lc-slash">
						{slashMatches.map((c, i) => (
							<div
								key={c.name}
								className="lc-slash-item"
								data-active={i === activeSlash}
								onMouseDown={e => {
									e.preventDefault();
									runSlashName(c.name);
								}}
							>
								<span className="lc-slash-name">/{c.name}</span>
								<span className="lc-slash-desc">{c.description ?? c.argHint ?? ""}</span>
							</div>
						))}
					</div>
				)}
				{historyOpen && historyMatches.length > 0 && (
					<div className="lc-slash lc-history">
						{historyMatches.map((h, i) => (
							<div
								key={h}
								className="lc-slash-item"
								data-active={i === historyIdx}
								onMouseDown={e => {
									e.preventDefault();
									setText(h);
									setHistoryOpen(false);
								}}
							>
								<span className="lc-history-text">{h}</span>
							</div>
						))}
					</div>
				)}
				<textarea
					value={text}
					placeholder={readOnly ? "read-only session" : "Message, or / for commands"}
					disabled={readOnly}
					onChange={e => setText(e.target.value)}
					onKeyDown={e => {
						if (historyOpen) {
							if (e.key === "ArrowDown" || e.key === "ArrowUp") {
								e.preventDefault();
								setHistoryIdx(prev => {
									const n = historyMatches.length;
									if (n === 0) return 0;
									return e.key === "ArrowDown" ? (prev + 1) % n : (prev - 1 + n) % n;
								});
								return;
							}
							if (e.key === "Enter") {
								e.preventDefault();
								const pick = historyMatches[historyIdx];
								if (pick) setText(pick);
								setHistoryOpen(false);
								return;
							}
							if (e.key === "Escape") {
								e.preventDefault();
								setHistoryOpen(false);
								return;
							}
						}
						if (e.ctrlKey && e.code === "KeyR") {
							e.preventDefault();
							setHistoryOpen(o => !o);
							setHistoryIdx(0);
							return;
						}
						if (e.altKey && e.key === "ArrowUp" && !readOnly) {
							e.preventDefault();
							void client.dequeue().then(r => {
								if (r) setText(r.text);
							});
							return;
						}
						if (slashMatches.length > 0 && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
							e.preventDefault();
							setActiveSlash(prev => {
								const n = slashMatches.length;
								return e.key === "ArrowDown" ? (prev + 1) % n : (prev - 1 + n) % n;
							});
							return;
						}
						if (e.key === "Tab" && slashMatches.length > 0) {
							e.preventDefault();
							const match = slashMatches[activeSlash];
							if (match) applySlash(match.name);
							return;
						}
						if (
							(e.key === "Enter" && (e.ctrlKey || e.metaKey)) ||
							(e.code === "KeyQ" && e.ctrlKey && !e.altKey)
						) {
							// app.message.followUp (ctrl+enter / ctrl+q): send as a follow-up turn.
							e.preventDefault();
							submit("followUp");
							return;
						}
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							// Palette open: one Enter runs the highlighted command directly.
							// (Tab completes it into the input instead, for adding arguments.)
							if (slashMatches.length > 0) {
								const match = slashMatches[activeSlash];
								if (match) runSlashName(match.name);
								return;
							}
							submit("steer");
						}
					}}
				/>
				{snapshot.working ? (
					<button type="button" onClick={() => client.sendAbort()}>
						Stop
					</button>
				) : (
					<button type="button" disabled={readOnly} onClick={() => submit()}>
						Send
					</button>
				)}
			</div>
		</div>
	);
}
