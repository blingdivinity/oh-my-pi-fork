import type { WebSetting, WebSettingsTab } from "@oh-my-pi/pi-wire/web";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { LocalClient } from "../../lib/local-client";

interface SettingsPanelProps {
	client: LocalClient;
	tabs: readonly WebSettingsTab[];
	onClose: () => void;
}

function tabLabel(id: string): string {
	return id.charAt(0).toUpperCase() + id.slice(1);
}

/**
 * Web counterpart to the TUI `/settings` menu. Renders the SAME declarative
 * settings catalog (tabs → settings) the gateway projects from settings-defs,
 * and writes edits back through the shared Settings store (visible to the TUI).
 */
export function SettingsPanel({ client, tabs, onClose }: SettingsPanelProps): ReactNode {
	const [active, setActive] = useState(0);

	useEffect(() => {
		setActive(a => (a >= tabs.length ? 0 : a));
	}, [tabs.length]);

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

	const tab = tabs[active];

	return (
		<div className="lc-modal-backdrop" onMouseDown={onClose}>
			<div className="lc-modal lc-settings" onMouseDown={e => e.stopPropagation()}>
				<h3>Settings</h3>
				{tabs.length === 0 ? (
					<div className="lc-picker-empty">no settings available</div>
				) : (
					<>
						<div className="lc-settings-tabs">
							{tabs.map((t, i) => (
								<button
									type="button"
									key={t.id}
									className="lc-settings-tab"
									data-active={i === active}
									onClick={() => setActive(i)}
								>
									{tabLabel(t.id)}
								</button>
							))}
						</div>
						<div className="lc-settings-body">
							{tab?.settings.map(s => (
								<div key={s.path} className="lc-setting">
									<div className="lc-setting-info">
										<span className="lc-setting-label">{s.label}</span>
										<span className="lc-setting-desc">{s.description}</span>
									</div>
									<div className="lc-setting-control">
										<SettingControl client={client} setting={s} />
									</div>
								</div>
							))}
						</div>
					</>
				)}
			</div>
		</div>
	);
}

function SettingControl({ client, setting }: { client: LocalClient; setting: WebSetting }): ReactNode {
	if (setting.kind === "boolean") {
		return (
			<input
				type="checkbox"
				checked={setting.value === true}
				onChange={e => void client.setSetting(setting.path, e.target.checked)}
			/>
		);
	}
	if (setting.kind === "enum" || setting.kind === "submenu") {
		const opts = setting.options ?? [];
		const current = String(setting.value);
		return (
			<select value={current} onChange={e => void client.setSetting(setting.path, e.target.value)}>
				{!opts.some(o => o.value === current) && <option value={current}>{current || "(unset)"}</option>}
				{opts.map(o => (
					<option key={o.value} value={o.value}>
						{o.label}
					</option>
				))}
			</select>
		);
	}
	const current = String(setting.value);
	return (
		<input
			type="text"
			defaultValue={current}
			onBlur={e => {
				if (e.target.value !== current) void client.setSetting(setting.path, e.target.value);
			}}
			onKeyDown={e => {
				if (e.key === "Enter") (e.target as HTMLInputElement).blur();
			}}
		/>
	);
}
