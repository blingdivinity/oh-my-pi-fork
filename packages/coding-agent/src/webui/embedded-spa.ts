/**
 * SPA asset resolution for the in-process web server.
 *
 * `spa-archive.generated.txt` holds the base64 of a gzipped tar of the built
 * collab-web SPA (`packages/collab-web/dist`). It is empty in the dev tree —
 * `scripts/embed-spa.ts --generate` populates it for compiled binaries / the
 * prepacked npm bundle, mirroring the omp-stats embedded-dashboard pattern.
 *
 * Resolution order:
 *  1. embedded archive present (or prebuilt runtime) → extract to a temp dir
 *  2. dev tree → serve `collab-web/dist`, building it on demand if missing
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import spaArchiveTxt from "./spa-archive.generated.txt" with { type: "text" };

/**
 * Decode the generated archive text. Blank/non-base64/non-gzip content (the dev
 * placeholder) decodes to `null` = "no archive embedded".
 */
export function decodeEmbeddedSpaArchive(txt: string): Buffer | null {
	const normalized = txt.replaceAll(/\s+/g, "");
	if (!normalized) return null;
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) return null;
	const bytes = Buffer.from(normalized, "base64");
	if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return null;
	return bytes;
}

const EMBEDDED_SPA_ARCHIVE = decodeEmbeddedSpaArchive(spaArchiveTxt);

const IS_BUN_COMPILED =
	Boolean(process.env.PI_COMPILED || Bun.env.PI_COMPILED) ||
	import.meta.url.includes("$bunfs") ||
	import.meta.url.includes("~BUN") ||
	import.meta.url.includes("%7EBUN");
const IS_PREBUILT = IS_BUN_COMPILED || Boolean(process.env.PI_BUNDLED || Bun.env.PI_BUNDLED);

const EXTRACT_ROOT = path.join(os.tmpdir(), "omp-web-spa");
let extractedDirPromise: Promise<string> | null = null;

/** Built collab-web SPA dir in the dev/source tree. */
export function collabWebDistDir(): string {
	return path.resolve(import.meta.dir, "..", "..", "..", "collab-web", "dist");
}

function sanitizeArchivePath(archivePath: string): string | null {
	const normalized = archivePath.replaceAll("\\", "/").replace(/^\.\//, "");
	if (!normalized || normalized === ".") return null;
	if (normalized.includes("..") || path.isAbsolute(normalized)) return null;
	return normalized;
}

async function extractEmbeddedSpa(archiveBytes: Buffer): Promise<string> {
	if (extractedDirPromise) return extractedDirPromise;
	extractedDirPromise = (async () => {
		const outputDir = path.join(EXTRACT_ROOT, Bun.hash(archiveBytes).toString(16));
		const marker = path.join(outputDir, "index.html");
		try {
			if ((await fs.stat(marker)).isFile()) return outputDir;
		} catch {}
		await fs.rm(outputDir, { recursive: true, force: true });
		await fs.mkdir(outputDir, { recursive: true });
		const archive = new Bun.Archive(archiveBytes);
		const root = path.resolve(outputDir);
		for (const [archivePath, file] of await archive.files()) {
			const safe = sanitizeArchivePath(archivePath);
			if (!safe) continue;
			const dest = path.resolve(root, safe);
			if (!dest.startsWith(root + path.sep)) throw new Error(`archive entry escapes: ${archivePath}`);
			await Bun.write(dest, file);
		}
		return outputDir;
	})();
	return extractedDirPromise;
}

async function buildCollabWebSpa(distDir: string): Promise<void> {
	const collabWeb = path.resolve(distDir, "..");
	logger.info("building collab-web SPA for web UI", { collabWeb });
	const result = await $`bun run build`.cwd(collabWeb).quiet().nothrow();
	if (result.exitCode !== 0) {
		throw new Error(`failed to build the web UI SPA (collab-web). Run: bun --cwd ${collabWeb} run build`);
	}
}

/**
 * Resolve a directory containing the built SPA (index.html + assets) ready to
 * serve. Extracts the embedded archive when present/prebuilt; otherwise serves
 * the dev dist, building it on first use if absent.
 */
export async function resolveWebSpaDir(): Promise<string> {
	if (EMBEDDED_SPA_ARCHIVE) return extractEmbeddedSpa(EMBEDDED_SPA_ARCHIVE);
	if (IS_PREBUILT) {
		throw new Error(
			"Embedded web UI bundle missing. Rebuild omp with embedded web assets (scripts/embed-spa.ts --generate).",
		);
	}
	const dist = collabWebDistDir();
	if (!(await Bun.file(path.join(dist, "index.html")).exists())) {
		await buildCollabWebSpa(dist);
	}
	return dist;
}
