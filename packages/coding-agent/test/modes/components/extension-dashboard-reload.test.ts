import { describe, expect, test } from "bun:test";
import * as path from "node:path";

const probePath = path.join(import.meta.dir, "..", "..", "fixtures", "extension-dashboard-reload-probe.ts");

describe("ExtensionDashboard live resource reconciliation", () => {
	test("invokes the session reload callback after persisting an extension toggle", async () => {
		const probe = Bun.spawn(["bun", probePath], {
			cwd: path.join(import.meta.dir, "..", "..", ".."),
			stdout: "pipe",
			stderr: "pipe",
		});
		const timeout = setTimeout(() => probe.kill(), 10_000);
		const [exitCode, stdout, stderr] = await Promise.all([
			probe.exited,
			new Response(probe.stdout).text(),
			new Response(probe.stderr).text(),
		]).finally(() => clearTimeout(timeout));

		expect(exitCode, stderr).toBe(0);
		expect(JSON.parse(stdout)).toEqual({ disabledAtCallback: ["skill:live-toggle"] });
	});
});
