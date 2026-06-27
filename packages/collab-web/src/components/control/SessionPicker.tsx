import type { WebSessionInfo } from "@oh-my-pi/pi-wire/web";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { LocalClient } from "../../lib/local-client";

interface SessionPickerProps {
	client: LocalClient;
	onClose: () => void;
}

function when(ms: number): string {
	const d = new Date(ms);
	return Number.isFinite(d.getTime()) && ms > 0 ? d.toLocaleString() : "";
}

/** Web counterpart to the TUI `/resume` picker: lists saved sessions and switches. */
export function SessionPicker({ client, onClose }: SessionPickerProps): ReactNode {
	const [sessions, setSessions] = useState<WebSessionInfo[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let live = true;
		client.listSessions().then(
			list => {
				if (live) setSessions(list);
			},
			err => {
				if (live) setError(String(err));
			},
		);
		return () => {
			live = false;
		};
	}, [client]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") {
				e.preventDefault();
				onClose();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	const choose = (s: WebSessionInfo): void => {
		if (!s.current) void client.switchSession(s.path);
		onClose();
	};

	return (
		<div className="lc-modal-backdrop" onMouseDown={onClose}>
			<div className="lc-modal lc-picker" onMouseDown={e => e.stopPropagation()}>
				<h3>Resume session</h3>
				<div className="lc-picker-list">
					{error && <div className="lc-picker-empty">failed to list sessions: {error}</div>}
					{sessions === null && !error && <div className="lc-picker-empty">loading…</div>}
					{sessions && sessions.length === 0 && <div className="lc-picker-empty">no saved sessions</div>}
					{sessions?.map(s => (
						<div
							key={s.path}
							className="lc-picker-item"
							data-current={s.current}
							onMouseDown={e => {
								e.preventDefault();
								choose(s);
							}}
						>
							<span className="lc-picker-name">
								{s.title || s.firstMessage || s.id}
								{s.current ? "  ✓" : ""}
							</span>
							<span className="lc-picker-id">
								{s.messageCount} msgs · {when(s.modified)}
							</span>
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
