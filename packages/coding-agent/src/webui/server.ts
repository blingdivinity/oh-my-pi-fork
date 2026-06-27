/**
 * In-process web server for the full-parity web UI.
 *
 * Mirrors `runRpcMode` (a thin I/O layer over the shared {@link AgentSession})
 * but speaks the web protocol over WebSocket and serves the SPA over HTTP via
 * `Bun.serve` — the same in-process-server pattern as `omp stats`. The
 * {@link SessionGateway} owns all session ↔ wire translation; this module owns
 * only the transport: WS framing, static asset serving, and loopback auth.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import type { ServerWebSocket } from "bun";
import { reset as resetCapabilities } from "../capability";
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "../discovery/helpers";
import type { ExtensionUIContext } from "../extensibility/extensions";
import { loadSlashCommands } from "../extensibility/slash-commands";
import type { MCPManager } from "../mcp";
import { initializeExtensions } from "../modes/runtime-init";
import type { AgentSession } from "../session/agent-session";
import type { EventBus } from "../utils/event-bus";
import { SessionGateway } from "./gateway";
import type { GatewayInbound, GatewayOutbound, GatewayPeer } from "./types";

/** Per-connection data carried through the WebSocket upgrade. */
interface WsData {
	id: string;
	canWrite: boolean;
	control: boolean;
	peer?: GatewayPeer;
}

/** A {@link GatewayPeer} backed by a Bun ServerWebSocket (plaintext local transport). */
class WsGatewayPeer implements GatewayPeer {
	name: string;
	canWrite: boolean;
	control: boolean;
	readOnly: boolean;
	readonly #ws: ServerWebSocket<WsData>;

	constructor(ws: ServerWebSocket<WsData>) {
		this.#ws = ws;
		this.name = ws.data.id;
		this.canWrite = ws.data.canWrite;
		this.control = ws.data.control;
		this.readOnly = !ws.data.canWrite;
	}

	get id(): string {
		return this.#ws.data.id;
	}

	send(frame: GatewayOutbound): void {
		if (this.#ws.readyState === 1) this.#ws.send(JSON.stringify(frame));
	}

	close(reason?: string): void {
		this.#ws.close(1000, reason?.slice(0, 120));
	}
}

export interface WebServerOptions {
	port?: number;
	host?: string;
	/** Auth token required on the WS upgrade and embedded in the served SPA. */
	token: string;
	/** Directory of the built SPA (collab-web dist). */
	spaDir?: string;
	/** Whether new peers get write + control capability (loopback default true). */
	canWrite?: boolean;
}

export interface RunningWebServer {
	port: number;
	host: string;
	url: string;
	stop(): void;
}

const DEFAULT_PORT = 7878;
const DEFAULT_HOST = "127.0.0.1";

function resolveDefaultSpaDir(): string {
	// packages/coding-agent/src/webui/server.ts → packages/collab-web/dist
	return path.resolve(import.meta.dir, "..", "..", "..", "collab-web", "dist");
}

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".webmanifest": "application/manifest+json",
	".woff2": "font/woff2",
};

/** Inject the local-profile bootstrap config into the SPA shell. */
function injectConfig(html: string, token: string): string {
	const config = JSON.stringify({ profile: "local", wsPath: "/ws", token });
	const tag = `<script>window.__OMP_WEB=${config};</script>`;
	return html.includes("</head>") ? html.replace("</head>", `${tag}</head>`) : `${tag}${html}`;
}

/** Hostnames accepted as loopback (defends against DNS-rebinding to a local server with a `bash` op). */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function hostnameWithoutPort(value: string | null): string | null {
	if (!value) return null;
	const trimmed = value.trim();
	if (trimmed.startsWith("[")) return trimmed.slice(0, trimmed.indexOf("]") + 1);
	const colon = trimmed.lastIndexOf(":");
	return colon === -1 ? trimmed : trimmed.slice(0, colon);
}

/**
 * Reject non-loopback Host headers and cross-origin WebSocket upgrades. A
 * rebound DNS name resolving to 127.0.0.1 still carries the attacker's domain
 * in `Host`/`Origin`, so this blocks the rebinding path to the control surface.
 */
function isLoopbackRequest(req: Request): boolean {
	const host = hostnameWithoutPort(req.headers.get("host"));
	if (!host || !LOOPBACK_HOSTS.has(host)) return false;
	const origin = req.headers.get("origin");
	if (origin) {
		try {
			if (!LOOPBACK_HOSTS.has(new URL(origin).hostname)) return false;
		} catch {
			return false;
		}
	}
	return true;
}

/** Start the HTTP+WS server for a gateway. */
export function startWebServer(gateway: SessionGateway, options: WebServerOptions): RunningWebServer {
	const host = options.host ?? DEFAULT_HOST;
	const spaDir = options.spaDir ?? resolveDefaultSpaDir();
	const canWrite = options.canWrite ?? true;

	const serveAsset = async (pathname: string): Promise<Response> => {
		const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
		// Prevent traversal outside the SPA dir.
		const resolved = path.resolve(spaDir, rel);
		if (!resolved.startsWith(path.resolve(spaDir))) return new Response("forbidden", { status: 403 });
		try {
			const ext = path.extname(resolved);
			const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";
			if (ext === ".html") {
				const html = await fs.readFile(resolved, "utf-8");
				return new Response(injectConfig(html, options.token), { headers: { "Content-Type": contentType } });
			}
			const data = await fs.readFile(resolved);
			return new Response(data, { headers: { "Content-Type": contentType } });
		} catch (err) {
			if (isEnoent(err)) {
				// SPA fallback: serve index.html for client-side routes.
				try {
					const html = await fs.readFile(path.join(spaDir, "index.html"), "utf-8");
					return new Response(injectConfig(html, options.token), {
						headers: { "Content-Type": "text/html; charset=utf-8" },
					});
				} catch {
					return new Response("web UI assets not built (run: bun --cwd packages/collab-web run build)", {
						status: 404,
					});
				}
			}
			throw err;
		}
	};

	const server = Bun.serve<WsData>({
		port: options.port ?? DEFAULT_PORT,
		hostname: host,
		idleTimeout: 120,
		async fetch(req, srv) {
			const url = new URL(req.url);
			if (!isLoopbackRequest(req)) return new Response("forbidden", { status: 403 });
			if (url.pathname === "/ws") {
				if (url.searchParams.get("token") !== options.token) return new Response("forbidden", { status: 403 });
				const data: WsData = { id: crypto.randomUUID(), canWrite, control: true };
				if (srv.upgrade(req, { data })) return undefined;
				return new Response("websocket upgrade failed", { status: 500 });
			}
			if (url.pathname === "/healthz") return new Response("ok");
			return serveAsset(url.pathname);
		},
		websocket: {
			open(ws) {
				// Create the peer but DO NOT register it for broadcasts yet — the
				// gateway adds it to the broadcast set inside #onHello, after the
				// welcome + snapshot, so live frames can't precede the snapshot.
				ws.data.peer = new WsGatewayPeer(ws);
			},
			message(ws, message) {
				const peer = ws.data.peer;
				if (!peer) return;
				let frame: GatewayInbound;
				try {
					frame = JSON.parse(typeof message === "string" ? message : message.toString()) as GatewayInbound;
				} catch {
					peer.send({ t: "error", message: "malformed frame" });
					return;
				}
				gateway.handleFrame(peer, frame);
			},
			close(ws) {
				if (ws.data.peer) gateway.removePeer(ws.data.peer);
			},
		},
	});

	const boundPort = server.port ?? options.port ?? DEFAULT_PORT;
	return {
		port: boundPort,
		host,
		url: `http://${host}:${boundPort}/`,
		stop: () => server.stop(true),
	};
}

export interface RunWebModeOptions {
	setToolUIContext?: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
	eventBus?: EventBus;
	mcpManager?: MCPManager;
	port?: number;
	host?: string;
	spaDir?: string;
}

/**
 * Web mode entry — sibling of `runRpcMode`. Builds the gateway, wires the
 * extension UI context, starts the server, and parks forever.
 */
export async function runWebMode(session: AgentSession, options: RunWebModeOptions = {}): Promise<never> {
	const reloadPlugins = async () => {
		const cwd = session.sessionManager.getCwd();
		const projectPath = await resolveActiveProjectRegistryPath(cwd);
		clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
		resetCapabilities();
		session.setSlashCommands(await loadSlashCommands({ cwd }));
		await session.refreshSshTool({ activateIfAvailable: true });
	};

	const gateway = new SessionGateway({
		session,
		eventBus: options.eventBus,
		mcpManager: options.mcpManager,
		reloadPlugins,
	});

	options.setToolUIContext?.(gateway.extensionUIContext, true);
	await initializeExtensions(session, {
		reportSendError: (action, err) => logger.warn("web extension send failed", { action, error: err.message }),
		reportRuntimeError: err =>
			logger.warn("web extension runtime error", { extensionPath: err.extensionPath, error: err.error }),
		uiContext: gateway.extensionUIContext,
	});

	gateway.start();
	const token = crypto.randomUUID();
	const running = startWebServer(gateway, {
		token,
		port: options.port,
		host: options.host,
		spaDir: options.spaDir,
	});
	const link = `${running.url}#token=${token}`;
	process.stdout.write(`omp web UI: ${link}\n`);
	logger.info("web UI started", { url: running.url });

	// Park forever; the server runs on the event loop.
	await new Promise<never>(() => {});
	throw new Error("unreachable");
}
