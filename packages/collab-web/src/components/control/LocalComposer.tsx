import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import type { LocalClient, LocalSnapshot } from "../../lib/local-client";

interface LocalComposerProps {
	client: LocalClient;
	snapshot: LocalSnapshot;
}

export function LocalComposer({ client, snapshot }: LocalComposerProps): ReactNode {
	const [text, setText] = useState("");
	const [activeSlash, setActiveSlash] = useState(0);
	const readOnly = snapshot.readOnly;

	const slashMatches = useMemo(() => {
		// Only while still typing the command name (no space/args yet).
		if (!text.startsWith("/") || text.includes(" ")) return [];
		const token = text.slice(1).toLowerCase();
		return snapshot.commands.filter(c => c.name.toLowerCase().startsWith(token)).slice(0, 8);
	}, [text, snapshot.commands]);

	const submit = (): void => {
		const value = text.trim();
		if (!value || readOnly) return;
		if (value.startsWith("/")) void client.runSlash(value);
		else void client.prompt(value);
		setText("");
		setActiveSlash(0);
	};

	const applySlash = (name: string): void => {
		setText(`/${name} `);
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
							{m.name}
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
									applySlash(c.name);
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
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							// Palette open: Enter selects the highlighted command (fills it);
							// a second Enter runs it. Otherwise submit.
							if (slashMatches.length > 0) {
								const match = slashMatches[activeSlash];
								if (match) applySlash(match.name);
								return;
							}
							submit();
						}
					}}
				/>
				{snapshot.working ? (
					<button type="button" onClick={() => client.sendAbort()}>
						Stop
					</button>
				) : (
					<button type="button" disabled={readOnly} onClick={submit}>
						Send
					</button>
				)}
			</div>
		</div>
	);
}
