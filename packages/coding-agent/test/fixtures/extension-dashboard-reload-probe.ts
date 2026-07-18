import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initializeWithSettings, reset as resetDiscovery } from "@oh-my-pi/pi-coding-agent/discovery";
import { ExtensionDashboard } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/extension-dashboard";
import { initTheme, stopThemeWatcher } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-dashboard-reload-"));
const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-dashboard-agent-"));

try {
	setAgentDir(agentDir);
	await Bun.write(
		path.join(cwd, ".omp", "skills", "live-toggle", "SKILL.md"),
		"---\nname: live-toggle\ndescription: Toggle this skill.\n---\n\n# Live toggle\n",
	);
	const settings = await Settings.init({ inMemory: true, cwd });
	initializeWithSettings(settings);
	await initTheme(false);
	const dashboard = await ExtensionDashboard.create(cwd, settings, 30);
	const refreshed = Promise.withResolvers<void>();
	const refreshTimeout = setTimeout(
		() => refreshed.reject(new Error("Extension dashboard reload callback timed out")),
		5_000,
	);
	refreshTimeout.unref?.();
	let callbackCompleted = false;
	let disabledAtCallback: readonly string[] = [];
	dashboard.onResourcesChanged = async () => {
		disabledAtCallback = settings.get("disabledExtensions") ?? [];
		await Promise.resolve();
		callbackCompleted = true;
	};
	dashboard.onRequestRender = () => {
		if (callbackCompleted) refreshed.resolve();
	};
	dashboard.handleInput("j");
	dashboard.handleInput(" ");
	await refreshed.promise.finally(() => clearTimeout(refreshTimeout));
	process.stdout.write(`${JSON.stringify({ disabledAtCallback })}\n`);
} finally {
	stopThemeWatcher();
	resetDiscovery();
	resetSettingsForTest();
	__resetDirsFromEnvForTests();
	await removeWithRetries(cwd);
	await removeWithRetries(agentDir);
}
