/**
 * Web settings bridge — projects the SAME declarative settings catalog the TUI
 * settings menu uses (`settings-defs` over `settings-schema`) into serializable
 * {@link WebSettingsTab}s, and applies edits back through the shared
 * {@link Settings} store (which persists to the user's config files, so a web
 * write is visible to the TUI on next read).
 */

import type { WebSetting, WebSettingsTab } from "@oh-my-pi/pi-wire/web";
import type { Settings } from "../config/settings";
import { getType, SETTING_TABS, type SettingPath } from "../config/settings-schema";
import { getSettingDef, getSettingsForTab } from "../modes/components/settings-defs";

/** Build the serializable settings catalog (tabs → settings) from current values. */
export function buildWebSettings(settings: Settings): WebSettingsTab[] {
	const tabs: WebSettingsTab[] = [];
	for (const tab of SETTING_TABS) {
		const defs = getSettingsForTab(tab).filter(def => !def.condition || def.condition());
		if (defs.length === 0) continue;
		const out: WebSetting[] = [];
		for (const def of defs) {
			let raw: unknown;
			try {
				raw = settings.get(def.path);
			} catch {
				raw = undefined;
			}
			const base = {
				path: def.path,
				tab,
				group: def.group,
				label: def.label,
				description: def.description,
			};
			if (def.type === "boolean") {
				out.push({ ...base, kind: "boolean", value: raw === true });
			} else if (def.type === "enum") {
				out.push({
					...base,
					kind: "enum",
					options: def.values.map(v => ({ value: v, label: v })),
					value: String(raw ?? ""),
				});
			} else if (def.type === "submenu") {
				out.push({
					...base,
					kind: "submenu",
					options: def.options.map(o => ({ value: o.value, label: o.label })),
					value: String(raw ?? ""),
				});
			} else {
				out.push({ ...base, kind: "text", value: String(raw ?? "") });
			}
		}
		tabs.push({ id: tab, label: tab, settings: out });
	}
	return tabs;
}

/** Apply a single setting edit. Returns an error string, or null on success. */
export function applyWebSetting(settings: Settings, path: string, value: boolean | string): string | null {
	const def = getSettingDef(path as SettingPath);
	if (!def) return `unknown setting: ${path}`;
	// `this` must be preserved: call through `settings`, not an extracted method,
	// or Settings.set hits `this.get` on undefined. The path is a runtime union
	// member so SettingValue<P> can't be inferred — coercion is validated below.
	const apply = (p: SettingPath, val: unknown): void => {
		(settings as unknown as { set(path: SettingPath, value: unknown): void }).set(p, val);
	};
	try {
		const schemaType = getType(def.path);
		if (schemaType === "boolean") {
			apply(def.path, typeof value === "boolean" ? value : value === "true");
			return null;
		}
		if (schemaType === "number") {
			const n = Number(value);
			if (!Number.isFinite(n)) return `invalid number for ${path}: ${value}`;
			apply(def.path, n);
			return null;
		}
		const str = String(value);
		if (def.type === "enum" && !def.values.includes(str)) {
			return `invalid value for ${path}: ${str}`;
		}
		if (def.type === "submenu" && def.options.length > 0 && !def.options.some(o => o.value === str)) {
			return `invalid value for ${path}: ${str}`;
		}
		apply(def.path, str);
		return null;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}
