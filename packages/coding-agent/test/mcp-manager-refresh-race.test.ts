import { afterEach, describe, expect, it } from "bun:test";
import { MCPManager } from "../src/mcp/manager";
import type {
	MCPHttpServerConfig,
	MCPPrompt,
	MCPResource,
	MCPServerCapabilities,
	MCPToolDefinition,
} from "../src/mcp/types";

type RefreshKind = "tools" | "resources" | "prompts";
type JsonRpcRequest = {
	id?: string | number;
	method: string;
};

type RaceServer = {
	server: Bun.Server<undefined>;
	waitForOldList: Promise<void>;
	releaseOldList: () => void;
	config: MCPHttpServerConfig;
};

const activeManagers: MCPManager[] = [];
const activeServers: RaceServer[] = [];

afterEach(async () => {
	for (const manager of activeManagers.splice(0)) {
		await manager.disconnectAll();
	}
	for (const raceServer of activeServers.splice(0)) {
		raceServer.releaseOldList();
		raceServer.server.stop(true);
	}
});

function jsonRpcResponse(id: string | number | undefined, result: unknown, sessionId?: string): Response {
	const headers = new Headers({ "Content-Type": "application/json" });
	if (sessionId) headers.set("Mcp-Session-Id", sessionId);
	return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { headers });
}

function tool(name: string): MCPToolDefinition {
	return { name, inputSchema: { type: "object" } };
}

function resource(uri: string): MCPResource {
	return { uri, name: uri };
}

function prompt(name: string): MCPPrompt {
	return { name, description: name, arguments: [] };
}

function capabilitiesFor(kind: RefreshKind): MCPServerCapabilities {
	if (kind === "tools") return { tools: { listChanged: true } };
	if (kind === "resources") return { resources: { listChanged: true, subscribe: true } };
	return { prompts: { listChanged: true } };
}

function createRaceServer(kind: RefreshKind): RaceServer {
	let generation = 0;
	const sessions = new Map<string, number>();
	const requestCounts = new Map<string, number>();
	const oldListStarted = Promise.withResolvers<void>();
	const waitForOldList = oldListStarted.promise;
	let releaseOldList: (() => void) | undefined;

	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			if (request.method === "DELETE") return new Response(null, { status: 202 });
			if (request.method === "GET") return new Response(null, { status: 405 });
			const body = (await request.json()) as JsonRpcRequest;
			if (body.method === "initialize") {
				generation += 1;
				const sessionId = `generation-${generation}`;
				sessions.set(sessionId, generation);
				return jsonRpcResponse(
					body.id,
					{
						protocolVersion: "2025-03-26",
						capabilities: capabilitiesFor(kind),
						serverInfo: { name: "race-server", version: "1.0.0" },
					},
					sessionId,
				);
			}
			if (body.method === "notifications/initialized") return new Response(null, { status: 202 });

			const sessionId = request.headers.get("Mcp-Session-Id");
			const currentGeneration = sessionId ? sessions.get(sessionId) : undefined;
			if (!currentGeneration) return new Response("Missing MCP session", { status: 400 });

			const countKey = `${currentGeneration}:${body.method}`;
			const requestCount = (requestCounts.get(countKey) ?? 0) + 1;
			requestCounts.set(countKey, requestCount);

			if (currentGeneration === 1 && requestCount === 2 && body.method === `${kind}/list`) {
				oldListStarted.resolve();
				const response = Promise.withResolvers<Response>();
				releaseOldList = () => {
					releaseOldList = undefined;
					if (kind === "tools") response.resolve(jsonRpcResponse(body.id, { tools: [tool("old-tool")] }));
					else if (kind === "resources")
						response.resolve(jsonRpcResponse(body.id, { resources: [resource("old://resource")] }));
					else response.resolve(jsonRpcResponse(body.id, { prompts: [prompt("old-prompt")] }));
				};
				return response.promise;
			}

			if (body.method === "tools/list") {
				return jsonRpcResponse(body.id, {
					tools: [tool(currentGeneration === 1 ? "old-initial-tool" : "new-tool")],
				});
			}
			if (body.method === "resources/list") {
				return jsonRpcResponse(body.id, {
					resources: [resource(currentGeneration === 1 ? "old-initial://resource" : "new://resource")],
				});
			}
			if (body.method === "resources/templates/list") {
				return jsonRpcResponse(body.id, { resourceTemplates: [] });
			}
			if (body.method === "resources/subscribe" || body.method === "resources/unsubscribe") {
				return jsonRpcResponse(body.id, {});
			}
			if (body.method === "prompts/list") {
				return jsonRpcResponse(body.id, {
					prompts: [prompt(currentGeneration === 1 ? "old-initial-prompt" : "new-prompt")],
				});
			}
			return new Response(`Unexpected MCP method: ${body.method}`, { status: 404 });
		},
	});

	return {
		server,
		waitForOldList,
		releaseOldList: () => releaseOldList?.(),
		config: { type: "http", url: `http://127.0.0.1:${server.port}`, timeout: 5_000 },
	};
}

async function waitUntil(condition: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!condition() && Date.now() < deadline) {
		await Bun.sleep(0);
	}
	if (!condition()) throw new Error(`Timed out waiting for ${label}`);
}

async function replaceConnection(manager: MCPManager, raceServer: RaceServer): Promise<void> {
	await manager.disconnectAll();
	await manager.connectServers({ race: { ...raceServer.config } }, {});
}

describe("MCP manager refresh connection generations", () => {
	it("does not publish stale tools after a replacement connection", async () => {
		const raceServer = createRaceServer("tools");
		const manager = new MCPManager(process.cwd());
		activeServers.push(raceServer);
		activeManagers.push(manager);
		const publications: string[][] = [];
		manager.setOnToolsChanged(tools => publications.push(tools.map(toolDefinition => toolDefinition.label)));

		await manager.connectServers({ race: raceServer.config }, {});
		const oldRefresh = manager.refreshServerTools("race");
		await raceServer.waitForOldList;
		await replaceConnection(manager, raceServer);
		expect(manager.getTools().map(toolDefinition => toolDefinition.label)).toEqual(["race/new-tool"]);
		const publicationCount = publications.length;
		raceServer.releaseOldList();
		await oldRefresh;

		expect(manager.getTools().map(toolDefinition => toolDefinition.label)).toEqual(["race/new-tool"]);
		expect(publications).toHaveLength(publicationCount);
	});

	it("does not publish stale resources or subscriptions after a replacement connection", async () => {
		const raceServer = createRaceServer("resources");
		const manager = new MCPManager(process.cwd());
		activeServers.push(raceServer);
		activeManagers.push(manager);
		manager.setNotificationsEnabled(true);

		await manager.connectServers({ race: raceServer.config }, {});
		await waitUntil(
			() => manager.getNotificationState().subscriptions.get("race")?.has("old-initial://resource") === true,
			"initial resource subscription",
		);
		const oldRefresh = manager.refreshServerResources("race");
		await raceServer.waitForOldList;
		await replaceConnection(manager, raceServer);
		await waitUntil(
			() => manager.getServerResources("race")?.resources.some(item => item.uri === "new://resource") === true,
			"replacement resources",
		);
		await waitUntil(
			() => manager.getNotificationState().subscriptions.get("race")?.has("new://resource") === true,
			"replacement resource subscription",
		);
		raceServer.releaseOldList();
		await oldRefresh;

		expect(manager.getServerResources("race")?.resources.map(item => item.uri)).toEqual(["new://resource"]);
		expect(manager.getNotificationState().subscriptions.get("race")).toEqual(new Set(["new://resource"]));
	});

	it("does not publish stale prompts after a replacement connection", async () => {
		const raceServer = createRaceServer("prompts");
		const manager = new MCPManager(process.cwd());
		activeServers.push(raceServer);
		activeManagers.push(manager);
		const promptPublications: string[] = [];
		manager.setOnPromptsChanged(serverName => promptPublications.push(serverName));

		await manager.connectServers({ race: raceServer.config }, {});
		await waitUntil(
			() => manager.getServerPrompts("race")?.some(item => item.name === "old-initial-prompt") === true,
			"initial prompts",
		);
		const oldRefresh = manager.refreshServerPrompts("race");
		await raceServer.waitForOldList;
		await replaceConnection(manager, raceServer);
		await waitUntil(
			() => manager.getServerPrompts("race")?.some(item => item.name === "new-prompt") === true,
			"replacement prompts",
		);
		const publicationCount = promptPublications.length;
		raceServer.releaseOldList();
		await oldRefresh;

		expect(manager.getServerPrompts("race")?.map(item => item.name)).toEqual(["new-prompt"]);
		expect(promptPublications).toHaveLength(publicationCount);
	});
});
