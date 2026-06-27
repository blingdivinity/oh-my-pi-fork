import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import type { LocalClient, LocalSnapshot } from "../../lib/local-client";

const MODEL_MENU_CMDS = new Set(["model", "models", "switch"]);

interface LocalComposerProps {
	client: LocalClient;
	snapshot: LocalSnapshot;
	/** Open the model picker overlay for /model, /models, /switch. */
	onOpenModelPicker?: () => void;
	/** Open the settings panel for /settings. */
	onOpenSettings?: () => void;
	/** Open the hotkeys reference for /hotkeys. */
	onOpenHotkeys?: () => void;
}

export function LocalComposer({
	client,
	snapshot,
	onOpenModelPicker,
	onOpenSettings,
	onOpenHotkeys,
}: LocalComposerProps): ReactNode {
	const [text, setText] = useState("");
	const [activeSlash, setActiveSlash] = useState(0);
	const readOnly = snapshot.readOnly;
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
		return false;
	};

	const slashMatches = useMemo(() => {
		// Only while still typing the command name (no space/args yet).
		if (!text.startsWith("/") || text.includes(" ")) return [];
		const token = text.slice(1).toLowerCase();
		return snapshot.commands.filter(c => c.name.toLowerCase().startsWith(token)).slice(0, 8);
	}, [text, snapshot.commands]);

	const submit = (behavior: "steer" | "followUp" = "steer"): void => {
		const value = text.trim();
		if (!value || readOnly) return;
		if (value.startsWith("/")) {
			const [head, ...rest] = value.slice(1).split(/\s+/);
			if (rest.length > 0 || !tryLocalUi(head ?? "")) void client.runSlash(value);
		} else void client.prompt(value, behavior);
		setText("");
		setActiveSlash(0);
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
				<textarea
					value={text}
					placeholder={readOnly ? "read-only session" : "Message, or / for commands"}
					disabled={readOnly}
					onChange={e => setText(e.target.value)}
					onKeyDown={e => {
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
