import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { AgentsPanel } from "./components/agents/AgentsPanel";
import { ControlOverlays } from "./components/control/ControlOverlays";
import { ExtPanelHost } from "./components/control/ExtPanelHost";
import { LocalComposer } from "./components/control/LocalComposer";
import { Banners } from "./components/shell/Banners";
import { HeaderBar } from "./components/shell/HeaderBar";
import { Toasts } from "./components/shell/Toasts";
import { Transcript } from "./components/transcript/Transcript";
import { LocalClient } from "./lib/local-client";
import { localWsUrl, type OmpWebConfig, useLocalSnapshot } from "./lib/use-local";
import type { ToolRenderHost } from "./tool-render";
import "./components/shell/shell.css";
import "./components/control/control.css";

const NAME_KEY = "omp.web.name";

function storedName(): string {
	try {
		return localStorage.getItem(NAME_KEY) ?? "web";
	} catch {
		return "web";
	}
}

/** Root for the local full-control profile (served by the in-process web server). */
export function LocalApp({ config }: { config: OmpWebConfig }): ReactNode {
	const [client] = useState(() => new LocalClient({ wsUrl: localWsUrl(config), name: storedName() }));
	useEffect(() => {
		client.connect();
		return () => client.close();
	}, [client]);
	return <LocalSession client={client} />;
}

function LocalSession({ client }: { client: LocalClient }): ReactNode {
	const snap = useLocalSnapshot(client);
	const [railOpen, setRailOpen] = useState(false);
	const [selectedId, setSelectedId] = useState<string | null>(null);

	const subCount = useMemo(() => snap.agents.filter(a => a.kind === "sub").length, [snap.agents]);
	const agentIds = useMemo(() => new Set(snap.agents.map(a => a.id)), [snap.agents]);
	const toolHost = useMemo<ToolRenderHost>(
		() => ({
			hasAgent: id => agentIds.has(id),
			openAgent: id => {
				if (agentIds.has(id)) setSelectedId(id);
			},
		}),
		[agentIds],
	);

	const title = snap.header?.title ?? snap.state?.sessionName ?? "session";
	useEffect(() => {
		document.title = `${title} · omp`;
	}, [title]);

	return (
		<div className="sh-app">
			<HeaderBar
				snapshot={snap}
				subCount={subCount}
				railOpen={railOpen}
				onToggleRail={() => setRailOpen(open => !open)}
				onLeave={() => client.close()}
			/>
			<main className="sh-main">
				<section className="sh-content" data-rail={railOpen ? "true" : "false"}>
					<div className="sh-transcript">
						<Transcript
							entries={snap.entries}
							stream={snap.stream}
							streamDone={snap.streamDone}
							activeTools={snap.activeTools}
							working={snap.working}
							host={toolHost}
						/>
					</div>
				</section>
				{railOpen && (
					<>
						<div className="sh-rail-backdrop" onClick={() => setRailOpen(false)} />
						<aside className="sh-rail">
							<AgentsPanel
								agents={snap.agents}
								progress={snap.progress}
								lifecycle={snap.lifecycle}
								selectedId={selectedId}
								onSelect={setSelectedId}
							/>
						</aside>
					</>
				)}
			</main>
			<ExtPanelHost client={client} snapshot={snap} />
			{snap.commandOutput.length > 0 && (
				<details className="lc-cmdout">
					<summary>command output ({snap.commandOutput.length})</summary>
					<pre>{snap.commandOutput.join("\n")}</pre>
				</details>
			)}
			<LocalComposer client={client} snapshot={snap} />
			<ControlOverlays client={client} snapshot={snap} />
			<Banners
				phase={snap.phase}
				endedReason={snap.endedReason}
				onRejoin={() => client.connect()}
				onNewLink={() => window.location.reload()}
			/>
			<Toasts notices={snap.notices} />
		</div>
	);
}
