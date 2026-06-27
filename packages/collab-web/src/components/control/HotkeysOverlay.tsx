import type { ReactNode } from "react";
import { useEffect } from "react";

interface HotkeysOverlayProps {
	onClose: () => void;
}

/** Web shortcut reference (`/hotkeys`), mirroring the TUI's keyboard help. */
const ROWS: ReadonlyArray<{ keys: string; desc: string }> = [
	{ keys: "Enter", desc: "Send message · run highlighted slash command" },
	{ keys: "Shift+Enter", desc: "Newline in the composer" },
	{ keys: "Ctrl+Enter / Ctrl+Q", desc: "Send as a follow-up turn" },
	{ keys: "Tab", desc: "Complete the highlighted slash command (for args)" },
	{ keys: "Esc", desc: "Abort the current turn" },
	{ keys: "Shift+Tab", desc: "Cycle thinking level" },
	{ keys: "Ctrl+P / Shift+Ctrl+P", desc: "Cycle model forward / backward" },
	{ keys: "Alt+M / Alt+P", desc: "Open the model picker" },
	{ keys: "Alt+R", desc: "Retry the last failed turn" },
	{ keys: "Ctrl+T", desc: "Show / hide thinking blocks" },
	{ keys: "Ctrl+O", desc: "Expand / collapse all tool output" },
];

const COMMANDS: ReadonlyArray<{ cmd: string; desc: string }> = [
	{ cmd: "/model", desc: "Open the model picker" },
	{ cmd: "/settings", desc: "Open the settings panel" },
	{ cmd: "/plan", desc: "Toggle plan mode" },
	{ cmd: "/retry", desc: "Retry the last failed turn" },
	{ cmd: "/hotkeys", desc: "Show this reference" },
];

export function HotkeysOverlay({ onClose }: HotkeysOverlayProps): ReactNode {
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
			<div className="lc-modal lc-hotkeys" onMouseDown={e => e.stopPropagation()}>
				<h3>Keyboard shortcuts</h3>
				<div className="lc-hotkeys-grid">
					{ROWS.map(r => (
						<div key={r.keys} className="lc-hotkey">
							<kbd className="lc-hotkey-keys">{r.keys}</kbd>
							<span className="lc-hotkey-desc">{r.desc}</span>
						</div>
					))}
				</div>
				<h3>Commands</h3>
				<div className="lc-hotkeys-grid">
					{COMMANDS.map(c => (
						<div key={c.cmd} className="lc-hotkey">
							<kbd className="lc-hotkey-keys">{c.cmd}</kbd>
							<span className="lc-hotkey-desc">{c.desc}</span>
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
