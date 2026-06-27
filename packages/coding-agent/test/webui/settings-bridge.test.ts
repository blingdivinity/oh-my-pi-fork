import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { applyWebSetting, buildWebSettings } from "@oh-my-pi/pi-coding-agent/webui/settings-bridge";

describe("web settings bridge", () => {
	it("projects the TUI settings catalog (tabs + kinds) from the shared store", () => {
		const settings = Settings.isolated();
		const tabs = buildWebSettings(settings);

		// The web catalog mirrors the TUI settings tabs.
		expect(tabs.some(t => t.id === "appearance")).toBe(true);
		expect(tabs.some(t => t.id === "model")).toBe(true);
		expect(tabs.length).toBeGreaterThan(3);

		const all = tabs.flatMap(t => t.settings);
		// Every setting carries a path/label and a kind the UI can render.
		for (const s of all) {
			expect(s.path.length).toBeGreaterThan(0);
			expect(["boolean", "enum", "submenu", "text"]).toContain(s.kind);
			if (s.kind === "boolean") expect(typeof s.value).toBe("boolean");
		}
		// Enums expose their options.
		const anEnum = all.find(s => s.kind === "enum");
		expect(anEnum?.options?.length ?? 0).toBeGreaterThan(0);
	});

	it("writes edits through the shared Settings store (TUI-visible) and validates", () => {
		const settings = Settings.isolated();
		const all = buildWebSettings(settings).flatMap(t => t.settings);

		// Enum round-trip: applying a different option updates the same store the
		// TUI reads via settings.get().
		const enumSetting = all.find(s => s.kind === "enum" && (s.options?.length ?? 0) > 1);
		expect(enumSetting).toBeDefined();
		if (enumSetting?.options) {
			const next = enumSetting.options.find(o => o.value !== enumSetting.value)?.value;
			expect(next).toBeDefined();
			expect(applyWebSetting(settings, enumSetting.path, next as string)).toBeNull();
			const afterEnum = buildWebSettings(settings)
				.flatMap(t => t.settings)
				.find(s => s.path === enumSetting.path);
			expect(afterEnum?.value).toBe(next);
		}

		// Boolean round-trip.
		const boolSetting = all.find(s => s.kind === "boolean");
		expect(boolSetting).toBeDefined();
		if (boolSetting) {
			const target = boolSetting.value !== true;
			expect(applyWebSetting(settings, boolSetting.path, target)).toBeNull();
			const afterBool = buildWebSettings(settings)
				.flatMap(t => t.settings)
				.find(s => s.path === boolSetting.path);
			expect(afterBool?.value).toBe(target);
		}

		// Unknown path and invalid enum value are rejected with an error message.
		expect(applyWebSetting(settings, "this.path.does.not.exist", "x")).toMatch(/unknown setting/);
		if (enumSetting) {
			expect(applyWebSetting(settings, enumSetting.path, "__not_a_valid_option__")).toMatch(/invalid value/);
		}
	});
});
