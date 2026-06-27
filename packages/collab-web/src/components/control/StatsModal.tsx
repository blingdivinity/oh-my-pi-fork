import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { LocalClient } from "../../lib/local-client";

type LaunchState = { status: "loading" } | { status: "success"; url: string } | { status: "error"; error: string };

export function StatsModal({ client, onClose }: { client: LocalClient; onClose: () => void }): ReactNode {
	const [state, setState] = useState<LaunchState>({ status: "loading" });

	useEffect(() => {
		let live = true;

		const launch = async (): Promise<void> => {
			try {
				const result = await client.launchStats();
				if (!live) return;
				if ("url" in result) {
					setState({ status: "success", url: result.url });
				} else {
					setState({ status: "error", error: result.error });
				}
			} catch (err) {
				if (live) setState({ status: "error", error: String(err) });
			}
		};

		void launch();
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

	return (
		<div className="lc-modal-backdrop" onMouseDown={onClose}>
			<div className="lc-modal" onMouseDown={e => e.stopPropagation()}>
				<h3>Stats dashboard</h3>
				{state.status === "loading" && <p>Launching local stats dashboard…</p>}
				{state.status === "success" && (
					<>
						<p>Dashboard running at:</p>
						<p>
							<a href={state.url} target="_blank" rel="noreferrer">
								{state.url}
							</a>
						</p>
						<div className="lc-modal-actions">
							<button type="button" onClick={() => window.open(state.url, "_blank", "noreferrer")}>
								Open dashboard
							</button>
							<button type="button" onClick={onClose}>
								Close
							</button>
						</div>
					</>
				)}
				{state.status === "error" && (
					<>
						<pre>{state.error}</pre>
						<div className="lc-modal-actions">
							<button type="button" onClick={onClose}>
								Close
							</button>
						</div>
					</>
				)}
			</div>
		</div>
	);
}
