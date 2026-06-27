import type { WebSessionDetail } from "@oh-my-pi/pi-wire/web";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { shortenPath } from "../../lib/format";
import type { LocalClient } from "../../lib/local-client";

type SessionInfoState = {
	data: WebSessionDetail | null;
	loading: boolean;
};

export function SessionInfoPanel({ client, onClose }: { client: LocalClient; onClose: () => void }): ReactNode {
	const [state, setState] = useState<SessionInfoState>({ data: null, loading: true });

	useEffect(() => {
		let live = true;
		setState({ data: null, loading: true });
		client.getSessionDetail().then(
			data => {
				if (live) setState({ data, loading: false });
			},
			() => {
				if (live) setState({ data: null, loading: false });
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

	const { data, loading } = state;

	return (
		<div className="lc-modal-backdrop" onMouseDown={onClose}>
			<div className="lc-modal" onMouseDown={e => e.stopPropagation()}>
				<h3>Session</h3>
				{loading && <div>Loading…</div>}
				{!loading && data === null && <div>No session info available.</div>}
				{!loading && data && (
					<dl>
						<div>
							<dt>Title</dt>
							<dd>{data.title}</dd>
						</div>
						<div>
							<dt>ID</dt>
							<dd>{data.id}</dd>
						</div>
						<div>
							<dt>CWD</dt>
							<dd>{shortenPath(data.cwd)}</dd>
						</div>
						<div>
							<dt>File path</dt>
							<dd>{data.path === null ? "in-memory" : shortenPath(data.path)}</dd>
						</div>
						<div>
							<dt>Messages</dt>
							<dd>{data.messageCount.toLocaleString()}</dd>
						</div>
						<div>
							<dt>Model</dt>
							<dd>{data.model ?? "—"}</dd>
						</div>
						<div>
							<dt>Thinking</dt>
							<dd>{data.thinkingLevel ?? "—"}</dd>
						</div>
					</dl>
				)}
				<div className="lc-modal-actions">
					<button type="button" onClick={onClose}>
						Close
					</button>
				</div>
			</div>
		</div>
	);
}
