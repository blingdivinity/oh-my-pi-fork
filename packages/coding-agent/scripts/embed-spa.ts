#!/usr/bin/env bun
/**
 * Embed the collab-web SPA into the coding-agent for self-contained web UI
 * serving in compiled binaries / the prepacked npm bundle. Mirrors
 * `packages/stats/scripts/generate-client-bundle.ts`.
 *
 *   bun scripts/embed-spa.ts --generate   build collab-web + pack dist -> generated.txt
 *   bun scripts/embed-spa.ts --reset      restore the empty dev placeholder
 *
 * The runtime treats a blank file as "no archive embedded" and builds the SPA
 * from source instead (see src/webui/embedded-spa.ts).
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";

const GENERATED_FILE = path.join(import.meta.dir, "..", "src", "webui", "spa-archive.generated.txt");
const COLLAB_WEB_DIR = path.resolve(import.meta.dir, "..", "..", "collab-web");
const DIST_DIR = path.join(COLLAB_WEB_DIR, "dist");

async function collectFiles(dir: string): Promise<string[]> {
	const entries = await fs.readdir(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) files.push(...(await collectFiles(full)));
		else if (entry.isFile()) files.push(full);
	}
	files.sort((a, b) => a.localeCompare(b));
	return files;
}

async function buildArchiveBase64(dir: string): Promise<string> {
	const entries: Record<string, Uint8Array> = {};
	for (const filePath of await collectFiles(dir)) {
		const rel = path.relative(dir, filePath).split(path.sep).join("/");
		entries[rel] = await fs.readFile(filePath);
	}
	const tempPath = path.join(
		os.tmpdir(),
		`omp-web-spa-${Bun.hash(`${Date.now()}${Math.random()}`).toString(16)}.tar.gz`,
	);
	try {
		await Bun.Archive.write(tempPath, entries, { compress: "gzip" });
		return Buffer.from(await Bun.file(tempPath).bytes()).toString("base64");
	} finally {
		await fs.rm(tempPath, { force: true });
	}
}

async function main(): Promise<void> {
	if (process.argv.includes("--reset")) {
		await Bun.write(GENERATED_FILE, "");
		console.log(`Reset ${GENERATED_FILE}`);
		return;
	}
	if (!process.argv.includes("--generate")) {
		console.log(`Skipping ${GENERATED_FILE}; pass --generate to embed the SPA bundle`);
		return;
	}
	await $`bun run build`.cwd(COLLAB_WEB_DIR);
	const base64 = await buildArchiveBase64(DIST_DIR);
	await Bun.write(GENERATED_FILE, base64);
	console.log(`Generated ${GENERATED_FILE} (${(base64.length / 1024).toFixed(0)} KiB base64)`);
}

await main();
