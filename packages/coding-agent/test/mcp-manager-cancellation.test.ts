import { afterEach, describe, expect, it } from "bun:test";
import { MCPManager } from "../src/mcp/manager";
import type { MCPHttpServerConfig } from "../src/mcp/types";

type HangingStage = "initialize" | "tools" | "resources";
type JsonRpcRequest = { id?: string | number; method: string };

type HangingServer = {
	server: Bun.Server<undefined>;
	config: MCPHttpServerConfig;
	started: Promise<void>;
	requests: () => number;
};
type HangingCloseServer = {
	server: Bun.Server<undefined>;
	config: MCPHttpServerConfig;
	deleteStarted: Promise<void>;
};

const activeManagers: MCPManager[] = [];
const activeServers: Array<{ server: Bun.Server<undefined> }> = [];

afterEach(async () => {
	const cleanupSignal = AbortSignal.abort(new Error("MCP cancellation test cleanup"));
	for (const manager of activeManagers.splice(0)) await manager.disconnectAll(cleanupSignal);
	for (const hangingServer of activeServers.splice(0)) hangingServer.server.stop(true);
});

function jsonRpcResponse(id: string | number | undefined, result: unknown, sessionId?: string): Response {
	const headers = new Headers({ "Content-Type": "application/json" });
	if (sessionId) headers.set("Mcp-Session-Id", sessionId);
	return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { headers });
}

function createHangingServer(stage: HangingStage): HangingServer {
	const started = Promise.withResolvers<void>();
	let requestCount = 0;
	const hanging = Promise.withResolvers<Response>();
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			requestCount += 1;
			if (request.method === "DELETE") return new Response(null, { status: 202 });
			if (request.method === "GET") return new Response(null, { status: 405 });
			const body = (await request.json()) as JsonRpcRequest;
			if (body.method === "initialize") {
				if (stage === "initialize") {
					started.resolve();
					return hanging.promise;
				}
				return jsonRpcResponse(body.id, {
					protocolVersion: "2025-03-26",
					capabilities: {
						tools: { listChanged: false },
						...(stage === "resources" ? { resources: { listChanged: false } } : {}),
					},
					serverInfo: { name: "cancellation-server", version: "1.0.0" },
				});
			}
			if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
			if (body.method === "tools/list") {
				if (stage === "tools") {
					started.resolve();
					return hanging.promise;
				}
				if (stage === "resources") {
					return jsonRpcResponse(body.id, {
						tools: [{ name: "ready", inputSchema: { type: "object" } }],
					});
				}
			}
			if (body.method === "resources/list" && stage === "resources") {
				started.resolve();
				return hanging.promise;
			}
			if (body.method === "resources/templates/list" && stage === "resources") {
				return jsonRpcResponse(body.id, { resourceTemplates: [] });
			}
			return jsonRpcResponse(body.id, { tools: [], resources: [] });
		},
	});
	return {
		server,
		config: { type: "http", url: `http://127.0.0.1:${server.port}`, timeout: 5_000 },
		started: started.promise,
		requests: () => requestCount,
	};
}

function createHangingCloseServer(): HangingCloseServer {
	const deleteStarted = Promise.withResolvers<void>();
	const hangingDelete = Promise.withResolvers<Response>();
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			if (request.method === "DELETE") {
				deleteStarted.resolve();
				return hangingDelete.promise;
			}
			if (request.method === "GET") return new Response(null, { status: 405 });
			const body = (await request.json()) as JsonRpcRequest;
			if (body.method === "initialize") {
				return jsonRpcResponse(
					body.id,
					{
						protocolVersion: "2025-03-26",
						capabilities: { tools: { listChanged: false } },
						serverInfo: { name: "hanging-close-server", version: "1.0.0" },
					},
					"hanging-close-session",
				);
			}
			if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
			if (body.method === "tools/list") {
				return jsonRpcResponse(body.id, {
					tools: [{ name: "ready", inputSchema: { type: "object" } }],
				});
			}
			return jsonRpcResponse(body.id, { tools: [] });
		},
	});
	return {
		server,
		config: { type: "http", url: `http://127.0.0.1:${server.port}`, timeout: 0 },
		deleteStarted: deleteStarted.promise,
	};
}

describe("MCP manager cancellation", () => {
	it("rejects pre-aborted discovery without connecting or publishing", async () => {
		const hangingServer = createHangingServer("initialize");
		const manager = new MCPManager(process.cwd());
		activeServers.push(hangingServer);
		activeManagers.push(manager);
		const controller = new AbortController();
		const reason = new Error("pre-aborted discovery");
		controller.abort(reason);

		await expect(
			manager.connectServers({ server: hangingServer.config }, {}, undefined, controller.signal),
		).rejects.toBe(reason);
		expect(hangingServer.requests()).toBe(0);
		expect(manager.getConnectedServers()).toEqual([]);
		expect(manager.getTools()).toEqual([]);
	});

	it("rejects promptly when initialize hangs and leaves no connection or tools", async () => {
		const hangingServer = createHangingServer("initialize");
		const manager = new MCPManager(process.cwd());
		activeServers.push(hangingServer);
		activeManagers.push(manager);
		const controller = new AbortController();
		const reason = new Error("cancel hanging initialize");
		const discovery = manager.connectServers({ server: hangingServer.config }, {}, undefined, controller.signal);
		await hangingServer.started;
		controller.abort(reason);

		await expect(discovery).rejects.toBe(reason);
		expect(manager.getConnectedServers()).toEqual([]);
		expect(manager.getTools()).toEqual([]);
	});

	it("aborts an in-flight tools list before publishing the connection", async () => {
		const hangingServer = createHangingServer("tools");
		const manager = new MCPManager(process.cwd());
		activeServers.push(hangingServer);
		activeManagers.push(manager);
		const controller = new AbortController();
		const reason = new Error("cancel hanging tools list");
		const discovery = manager.connectServers({ server: hangingServer.config }, {}, undefined, controller.signal);
		await hangingServer.started;
		controller.abort(reason);

		const outcome = await Promise.race([
			discovery.then(
				() => "resolved",
				error => error,
			),
			Bun.sleep(100).then(() => "timed out"),
		]);
		expect(outcome).toBe(reason);
		expect(manager.getConnectedServers()).toEqual([]);
		expect(manager.getTools()).toEqual([]);
	});

	it("publishes empty tools when cancellation interrupts resource loading", async () => {
		const hangingServer = createHangingServer("resources");
		const manager = new MCPManager(process.cwd());
		activeServers.push(hangingServer);
		activeManagers.push(manager);
		const publications: string[][] = [];
		manager.setOnToolsChanged(tools => publications.push(tools.map(tool => tool.label)));
		const controller = new AbortController();
		const reason = new Error("cancel resource loading");
		const discovery = manager.connectServers({ server: hangingServer.config }, {}, undefined, controller.signal);
		await hangingServer.started;
		const result = await discovery;
		expect(result.tools.map(tool => tool.label)).toEqual(["server/ready"]);
		controller.abort(reason);
		await Bun.sleep(0);

		expect(manager.getConnectedServers()).toEqual([]);
		expect(manager.getTools()).toEqual([]);
		expect(publications.at(-1)).toEqual([]);
	});

	it("aborts rediscovery without waiting for a hanging transport close", async () => {
		const hangingServer = createHangingCloseServer();
		const manager = new MCPManager(process.cwd());
		activeServers.push(hangingServer);
		activeManagers.push(manager);
		await manager.connectServers({ server: hangingServer.config }, {});
		expect(manager.getTools().map(tool => tool.label)).toEqual(["server/ready"]);

		const controller = new AbortController();
		const reason = new Error("cancel hanging close");
		const rediscovery = manager.rediscoverAndConnect(process.cwd(), { signal: controller.signal });
		try {
			const closeStarted = await Promise.race([
				hangingServer.deleteStarted.then(() => true),
				Bun.sleep(1_000).then(() => false),
			]);
			expect(closeStarted).toBe(true);
			controller.abort(reason);
			const outcome = await Promise.race([
				rediscovery.then(
					() => "resolved",
					error => error,
				),
				Bun.sleep(100).then(() => "timed out"),
			]);
			expect(outcome).toBe(reason);
			expect(manager.getConnectedServers()).toEqual([]);
			expect(manager.getTools()).toEqual([]);
		} finally {
			controller.abort(reason);
			await Promise.allSettled([rediscovery]);
		}
	});
});
