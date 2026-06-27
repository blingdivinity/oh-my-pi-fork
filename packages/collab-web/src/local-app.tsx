import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { AgentsPanel } from "./components/agents/AgentsPanel";
import { ControlOverlays } from "./components/control/ControlOverlays";
import { ExtPanelHost } from "./components/control/ExtPanelHost";
import { HotkeysOverlay } from "./components/control/HotkeysOverlay";
import { LocalComposer } from "./components/control/LocalComposer";
import { ModelPicker } from "./components/control/ModelPicker";
import { SessionPicker } from "./components/control/SessionPicker";
import { SettingsPanel } from "./components/control/SettingsPanel";
import { Banners } from "./components/shell/Banners";
import { HeaderBar } from "./components/shell/HeaderBar";
import { Toasts } from "./components/shell/Toasts";
import { BranchContext, ThinkingHideContext, Transcript } from "./components/transcript/Transcript";
import { LocalClient } from "./lib/local-client";
import { localWsUrl, type OmpWebConfig, useLocalSnapshot } from "./lib/use-local";
import { ToolExpandContext, type ToolRenderHost } from "./tool-render";
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
	const [modelPicker, setModelPicker] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [expandTools, setExpandTools] = useState(false);
	const [hideThinking, setHideThinking] = useState(false);
	const [hotkeysOpen, setHotkeysOpen] = useState(false);
	const [sessionsOpen, setSessionsOpen] = useState(false);

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
	// TUI keybinding parity: shift+tab thinking · ctrl+p / shift+ctrl+p model
	// fwd/back · alt+m/alt+p model picker · alt+r retry · Esc abort. Captured
	// globally so they work from the composer.
	const working = snap.working;
	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if (e.code === "Tab" && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
				e.preventDefault();
				void client.cycleThinking();
			} else if (e.code === "KeyP" && e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey) {
				e.preventDefault();
				void client.cycleModel("backward");
			} else if (e.code === "KeyP" && e.ctrlKey && !e.shiftKey && !e.metaKey && !e.altKey) {
				e.preventDefault();
				void client.cycleModel("forward");
			} else if ((e.code === "KeyM" || e.code === "KeyP") && e.altKey && !e.ctrlKey && !e.metaKey) {
				// alt+m (select) / alt+p (select temporary) both open the model picker.
				e.preventDefault();
				setModelPicker(true);
			} else if (e.code === "KeyR" && e.altKey && !e.ctrlKey && !e.metaKey) {
				e.preventDefault();
				void client.retry();
			} else if (e.code === "KeyT" && e.ctrlKey && !e.shiftKey && !e.metaKey && !e.altKey) {
				e.preventDefault();
				setHideThinking(v => !v);
			} else if (e.code === "KeyO" && e.ctrlKey && !e.shiftKey && !e.metaKey && !e.altKey) {
				e.preventDefault();
				setExpandTools(v => !v);
			} else if (e.code === "Escape" && working) {
				e.preventDefault();
				client.sendAbort();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [client, working]);

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
						<ToolExpandContext.Provider value={expandTools}>
							<ThinkingHideContext.Provider value={hideThinking}>
								<BranchContext.Provider value={entryId => void client.branch(entryId)}>
									<Transcript
										entries={snap.entries}
										stream={snap.stream}
										streamDone={snap.streamDone}
										activeTools={snap.activeTools}
										working={snap.working}
										host={toolHost}
									/>
								</BranchContext.Provider>
							</ThinkingHideContext.Provider>
						</ToolExpandContext.Provider>
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
			{(snap.state?.planMode || snap.state?.goalMode) && (
				<div className="lc-modebar">
					{snap.state?.planMode && <span className="lc-mode lc-mode--plan">plan mode</span>}
					{snap.state?.goalMode && (
						<span className="lc-mode lc-mode--goal" title={snap.state.goalMode.objective}>
							goal · {snap.state.goalMode.status}: {snap.state.goalMode.objective}
						</span>
					)}
				</div>
			)}
			<LocalComposer
				client={client}
				snapshot={snap}
				onOpenModelPicker={() => setModelPicker(true)}
				onOpenSettings={() => {
					void client.getSettings();
					setSettingsOpen(true);
				}}
				onOpenHotkeys={() => setHotkeysOpen(true)}
				onOpenSessions={() => setSessionsOpen(true)}
			/>
			<ControlOverlays client={client} snapshot={snap} />
			{modelPicker && <ModelPicker client={client} models={snap.models} onClose={() => setModelPicker(false)} />}
			{settingsOpen && <SettingsPanel client={client} tabs={snap.settings} onClose={() => setSettingsOpen(false)} />}
			{hotkeysOpen && <HotkeysOverlay onClose={() => setHotkeysOpen(false)} />}
			{sessionsOpen && <SessionPicker client={client} onClose={() => setSessionsOpen(false)} />}
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
