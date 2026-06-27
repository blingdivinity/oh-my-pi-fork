import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import type { LocalClient, LocalSnapshot } from "../../lib/local-client";

interface ExtPanelHostProps {
	client: LocalClient;
	snapshot: LocalSnapshot;
}

interface PanelMessage {
	panelId: string;
	data: unknown;
}

function isPanelMessage(value: unknown): value is PanelMessage {
	return typeof value === "object" && value !== null && "panelId" in value && typeof value.panelId === "string";
}

/**
 * Mounts each extension panel in a sandboxed iframe (allow-scripts, NO
 * allow-same-origin → unique opaque origin, no access to the host realm, WS,
 * or token). Bridges host↔panel via postMessage only.
 */
export function ExtPanelHost({ client, snapshot }: ExtPanelHostProps): ReactNode {
	const frames = useRef(new Map<string, HTMLIFrameElement>());
	const knownPanels = snapshot.extPanels;

	// Panel → host: accept only messages from iframes we mounted, tagged with a known panelId.
	useEffect(() => {
		const onMessage = (ev: MessageEvent): void => {
			if (!isPanelMessage(ev.data)) return;
			const frame = frames.current.get(ev.data.panelId);
			if (!frame || ev.source !== frame.contentWindow) return;
			client.sendPanelMessage(ev.data.panelId, ev.data.data);
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [client]);

	// Host → panel: deliver to the matching iframe (opaque origin → target "*").
	useEffect(() => {
		return client.onPanelMessage((panelId, data) => {
			frames.current.get(panelId)?.contentWindow?.postMessage({ panelId, data }, "*");
		});
	}, [client]);

	if (knownPanels.length === 0) return null;
	return (
		<div className="lc-panels">
			{knownPanels.map(panel => (
				<div className="lc-panel" key={panel.id}>
					<iframe
						title={panel.title}
						src={panel.src}
						sandbox="allow-scripts"
						ref={el => {
							if (el) frames.current.set(panel.id, el);
							else frames.current.delete(panel.id);
						}}
					/>
				</div>
			))}
		</div>
	);
}
