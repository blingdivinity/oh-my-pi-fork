/**
 * Browser end-to-end: a real headless Chromium loads the SPA served by the
 * in-process web server, drives a prompt through the composer, and asserts the
 * streamed assistant turn renders — plus the control handshake (model picker).
 * This is the full-parity web UI exercised through the exact surface a user hits.
 *
 * Gated on Chromium ONLY (it loudly logs a skip so a skip is never mistaken for
 * a pass). The SPA is built on demand in beforeAll, since serving requires it.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getPuppeteerDir } from "@oh-my-pi/pi-utils";
import * as browsers from "@puppeteer/browsers";
import { $ } from "bun";
import puppeteer, { type Browser } from "puppeteer-core";
import { MOCK_REPLY, type MockWebServer, spaDir, startMockWebServer } from "./harness";

const SYSTEM_CHROME_PATHS = [
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
	"/usr/bin/google-chrome",
	"/usr/bin/google-chrome-stable",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
];

async function resolveChromium(): Promise<string | undefined> {
	const env = process.env.PUPPETEER_EXECUTABLE_PATH;
	if (env && fs.existsSync(env)) return env;
	try {
		const installed = await browsers.getInstalledBrowsers({ cacheDir: getPuppeteerDir() });
		const chrome = installed.find(b => b.browser === browsers.Browser.CHROME && fs.existsSync(b.executablePath));
		if (chrome) return chrome.executablePath;
	} catch {
		// fall through to system paths
	}
	return SYSTEM_CHROME_PATHS.find(p => fs.existsSync(p));
}
async function buildSpa(): Promise<void> {
	// Always rebuild so a stale dist (predating UI changes) can't pass/fail against old markup.
	const collabWeb = path.resolve(spaDir(), "..");
	await $`bun run build`.cwd(collabWeb).quiet();
}

const chromiumPath = await resolveChromium();
if (!chromiumPath) {
	console.warn(
		"[web-e2e] SKIPPED: no Chromium found (set PUPPETEER_EXECUTABLE_PATH or install via @puppeteer/browsers). " +
			"The full-parity browser e2e did NOT run.",
	);
}

let server: MockWebServer | undefined;
let browser: Browser | undefined;

describe("browser e2e: full-parity web UI", () => {
	beforeAll(async () => {
		if (!chromiumPath) return;
		await buildSpa();
		server = await startMockWebServer({ port: 0 });
		browser = await puppeteer.launch({
			headless: true,
			executablePath: chromiumPath,
			args: ["--no-sandbox", "--disable-setuid-sandbox"],
		});
	}, 120_000);

	afterAll(async () => {
		try {
			await browser?.close();
		} catch {
			// best-effort cleanup
		}
		try {
			await server?.stop();
		} catch {
			// best-effort cleanup
		}
	}, 30_000);

	it.skipIf(!chromiumPath)(
		"loads the SPA, streams a real assistant turn, and exposes the model picker",
		async () => {
			if (!server || !browser) throw new Error("harness not started");
			const page = await browser.newPage();
			try {
				await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "domcontentloaded" });

				// Composer renders, and the control handshake populates the model picker.
				await page.waitForSelector("textarea", { timeout: 15_000 });
				await page.waitForSelector("select option", { timeout: 15_000 });

				// Drive a prompt the way a user does.
				await page.type("textarea", "hello agent");
				await page.keyboard.press("Enter");

				// The real AgentSession's (mock-model) reply must stream into the transcript.
				await page.waitForFunction(
					(reply: string) =>
						(
							globalThis as unknown as { document: { body: { innerText: string } } }
						).document.body.innerText.includes(reply),
					{ timeout: 15_000, polling: 100 },
					MOCK_REPLY,
				);

				const body = await page.evaluate(
					() => (globalThis as unknown as { document: { body: { innerText: string } } }).document.body.innerText,
				);
				expect(body).toContain("hello agent");
				expect(body).toContain(MOCK_REPLY);
			} finally {
				await page.close();
			}
		},
		60_000,
	);
});
