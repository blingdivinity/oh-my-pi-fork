import { LogOut, PanelRight } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import type { GuestSnapshot } from "../../lib/client";
import { fmtPercent, shortenPath } from "../../lib/format";
import type { LocalClient } from "../../lib/local-client";
import { ThemeToggle } from "./ThemeToggle";

interface HeaderBarBaseProps {
	snapshot: GuestSnapshot;
	subCount: number;
	railOpen: boolean;
	onToggleRail(): void;
	onLeave(): void;
}

export interface HeaderBarProps extends HeaderBarBaseProps {
	client: LocalClient;
}

interface HeaderBarWithoutClientProps extends HeaderBarBaseProps {
	client?: undefined;
}

export function HeaderBar({
	client,
	snapshot,
	subCount,
	railOpen,
	onToggleRail,
	onLeave,
}: HeaderBarProps | HeaderBarWithoutClientProps): ReactNode {
	const { header, state, phase, readOnly } = snapshot;
	const title = state?.sessionName ?? header?.title ?? "session";
	const canRename = !readOnly && client != null;
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(title);

	function beginEdit(): void {
		if (!canRename) {
			return;
		}
		setDraft(title);
		setEditing(true);
	}

	function cancelEdit(): void {
		setDraft(title);
		setEditing(false);
	}

	async function commitEdit(): Promise<void> {
		const nextTitle = draft.trim();
		if (!client) {
			setEditing(false);
			return;
		}
		if (nextTitle) {
			await client.setSessionName(nextTitle);
		}
		setEditing(false);
	}

	const usage = state?.contextUsage;
	let pct: number | null = null;
	if (usage) {
		pct =
			usage.percent ??
			(usage.tokens != null && usage.contextWindow !== null && usage.contextWindow > 0
				? (usage.tokens / usage.contextWindow) * 100
				: null);
	}

	return (
		<header className="sh-header">
			<div className="sh-header-left">
				{editing && canRename ? (
					<input
						autoFocus
						className="sh-title-input"
						value={draft}
						onBlur={cancelEdit}
						onChange={event => setDraft(event.currentTarget.value)}
						onKeyDown={event => {
							if (event.key === "Escape") {
								event.preventDefault();
								cancelEdit();
								return;
							}
							if (event.key === "Enter") {
								event.preventDefault();
								void commitEdit();
							}
						}}
					/>
				) : canRename ? (
					<span className="sh-title" title="Click to rename" onClick={beginEdit}>
						{title}
					</span>
				) : (
					<span className="sh-title" title={title}>
						{title}
					</span>
				)}
				{state?.cwd && (
					<span className="sh-cwd" title={state.cwd}>
						{shortenPath(state.cwd)}
					</span>
				)}
			</div>
			<div className="sh-header-right">
				{readOnly && (
					<span className="sh-chip" title="you joined with a read-only link — watching only">
						read-only
					</span>
				)}
				{state?.model && <span className="sh-chip sh-chip-meta">{state.model.name}</span>}
				{state?.thinkingLevel && <span className="sh-chip sh-chip-meta">{state.thinkingLevel}</span>}
				{pct != null && (
					<span
						className={pct > 80 ? "sh-gauge sh-gauge-warn" : "sh-gauge"}
						title={`context · ${fmtPercent(pct)}`}
					>
						<span className="sh-gauge-track">
							<span className="sh-gauge-fill" style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
						</span>
						<span className="sh-gauge-pct">{fmtPercent(pct)}</span>
					</span>
				)}
				{state && state.participants.length > 0 && (
					<span className="sh-avatars">
						{state.participants.map((p, i) => (
							<span
								key={`${p.name}:${i}`}
								className={p.role === "host" ? "sh-avatar sh-avatar-host" : "sh-avatar"}
								title={`${p.name} · ${p.role}${p.readOnly ? " · view-only" : ""}`}
							>
								{(p.name[0] ?? "?").toUpperCase()}
							</span>
						))}
					</span>
				)}
				<span className={`sh-dot sh-dot-${phase}`} title={phase} />
				<ThemeToggle />
				<button
					type="button"
					className={railOpen ? "sh-btn sh-btn-icon sh-btn-on" : "sh-btn sh-btn-icon"}
					onClick={onToggleRail}
					title={railOpen ? "hide agents" : "show agents"}
				>
					<PanelRight size={14} />
					{subCount > 0 && <span className="sh-badge">{subCount}</span>}
				</button>
				<button type="button" className="sh-btn sh-btn-icon" onClick={onLeave} title="leave session">
					<LogOut size={14} />
				</button>
			</div>
		</header>
	);
}
