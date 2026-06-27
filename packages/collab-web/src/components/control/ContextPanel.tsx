import type { WebContextBreakdown } from "@oh-my-pi/pi-wire/web";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { LocalClient } from "../../lib/local-client";
import "./context-panel.css";

type ContextPanelState = {
	data: WebContextBreakdown | null;
	error: string | null;
	loading: boolean;
};

function barWidth(tokens: number, usedTokens: number): string {
	if (usedTokens <= 0) return "0%";
	const width = Math.max(0, Math.min(100, (tokens / usedTokens) * 100));
	return `${width}%`;
}

export function ContextPanel({ client, onClose }: { client: LocalClient; onClose: () => void }): ReactNode {
	const [state, setState] = useState<ContextPanelState>({ data: null, error: null, loading: true });

	useEffect(() => {
		let live = true;
		setState({ data: null, error: null, loading: true });
		client.getContextBreakdown().then(
			data => {
				if (live) setState({ data, error: null, loading: false });
			},
			err => {
				if (live) setState({ data: null, error: String(err), loading: false });
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

	const { data, error, loading } = state;

	return (
		<div className="lc-modal-backdrop" onMouseDown={onClose}>
			<div className="lc-modal lc-ctx" onMouseDown={e => e.stopPropagation()}>
				<h3>Context usage</h3>
				{loading && <div className="lc-ctx-empty">loading…</div>}
				{!loading && error && <div className="lc-ctx-empty">failed to load context usage: {error}</div>}
				{!loading && !error && data === null && <div className="lc-ctx-empty">context usage unavailable</div>}
				{!loading && !error && data && (
					<div className="lc-ctx-body">
						<div className="lc-ctx-summary">
							<div className="lc-ctx-used">
								<strong>{data.usedTokens.toLocaleString()}</strong> / {data.contextWindow.toLocaleString()}{" "}
								tokens ({Number.isFinite(data.percent) ? data.percent.toFixed(1) : "0.0"}%)
							</div>
							<div className="lc-ctx-free">{data.freeTokens.toLocaleString()} free</div>
						</div>
						<div className="lc-ctx-note">
							{data.anchored ? "measured from provider usage" : "estimated from local token accounting"}
						</div>
						{data.categories.length === 0 ? (
							<div className="lc-ctx-empty">no category breakdown available</div>
						) : (
							<div className="lc-ctx-list">
								{data.categories.map((category, index) => (
									<div key={`${category.label}:${index}`} className="lc-ctx-row">
										<div className="lc-ctx-row-head">
											<span className="lc-ctx-label">{category.label}</span>
											<span className="lc-ctx-tokens">{category.tokens.toLocaleString()} tokens</span>
										</div>
										<div className="lc-ctx-bar" aria-hidden="true">
											<div
												className="lc-ctx-bar-fill"
												style={{ width: barWidth(category.tokens, data.usedTokens) }}
											/>
										</div>
									</div>
								))}
							</div>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
