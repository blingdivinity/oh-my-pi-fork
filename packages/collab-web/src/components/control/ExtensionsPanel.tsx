import type { WebExtension } from "@oh-my-pi/pi-wire/web";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import type { LocalClient } from "../../lib/local-client";

interface ExtensionsPanelProps {
	client: LocalClient;
	onClose: () => void;
}

const KIND_ORDER: readonly string[] = [
	"extension-module",
	"skill",
	"slash-command",
	"tool",
	"mcp",
	"hook",
	"rule",
	"prompt",
	"instruction",
	"context-file",
];

/** Web counterpart to the TUI `/extensions` Control Center: read-only inventory of
 *  installed capabilities grouped by kind, with provider + state. */
export function ExtensionsPanel({ client, onClose }: ExtensionsPanelProps): ReactNode {
	const [exts, setExts] = useState<WebExtension[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let live = true;
		client.getExtensions().then(
			list => {
				if (live) setExts(list);
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

	const groups = useMemo(() => {
		const byKind = new Map<string, WebExtension[]>();
		for (const e of exts ?? []) {
			const list = byKind.get(e.kind);
			if (list) list.push(e);
			else byKind.set(e.kind, [e]);
		}
		const order = (k: string): number => {
			const i = KIND_ORDER.indexOf(k);
			return i === -1 ? KIND_ORDER.length : i;
		};
		return [...byKind.entries()].sort((a, b) => order(a[0]) - order(b[0]));
	}, [exts]);

	return (
		<div className="lc-modal-backdrop" onMouseDown={onClose}>
			<div className="lc-modal lc-ext" onMouseDown={e => e.stopPropagation()}>
				<h3>Extensions {exts ? `(${exts.length})` : ""}</h3>
				<div className="lc-ext-list">
					{error && <div className="lc-picker-empty">failed to load extensions: {error}</div>}
					{exts === null && !error && <div className="lc-picker-empty">loading…</div>}
					{exts && exts.length === 0 && <div className="lc-picker-empty">no extensions installed</div>}
					{groups.map(([kind, items]) => (
						<div key={kind} className="lc-ext-group">
							<div className="lc-ext-kind">
								{kind} ({items.length})
							</div>
							{items.map(e => (
								<div key={e.id} className="lc-ext-item" data-state={e.state}>
									<span className="lc-ext-name">
										{e.name}
										{e.trigger ? <span className="lc-ext-trigger"> {e.trigger}</span> : null}
									</span>
									<span className="lc-ext-meta">
										<span className="lc-ext-src">
											{e.provider} · {e.level}
										</span>
										{e.state !== "active" && <span className="lc-ext-state">{e.state}</span>}
									</span>
									{e.description && <span className="lc-ext-desc">{e.description}</span>}
								</div>
							))}
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
