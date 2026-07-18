/**
 * Regression test for issue #2100: omp startup blocked >25s while connecting
 * to MCP servers.
 *
 * The scenario: a configured MCP server is reachable at the transport layer
 * but never answers `initialize`. Before the fix `MCPManager.connectServers`
 * awaited every still-pending server that had no cached tools with an
 * unbounded `Promise.allSettled`, so the slowest server's per-request timeout
 * (`OMP_MCP_TIMEOUT_MS`, default 30 000 ms) gated the entire UI.
 *
 * Contract this test defends: when an MCP server stalls and has no cached
 * tools, `connectServers` MUST return inside the bounded startup window
 * (currently `STARTUP_TIMEOUT_MS = 250 ms`, padded here for scheduling
 * jitter) so the rest of session bring-up — model registry, prompt setup,
 * UI ready signal — is not gated on slow/dead servers. The slow server is
 * left in flight; its tools surface via the background `#onToolsChanged`
 * path if/when it eventually connects.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import * as mcpClient from "../src/mcp/client";
import { MCPManager } from "../src/mcp/manager";
import type { MCPServerConnection, MCPStdioServerConfig, MCPToolDefinition } from "../src/mcp/types";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "hang-during-init-mcp.ts");
const BUN_EXEC = process.execPath;

describe("MCP startup (issue #2100)", () => {
	let workDir: string;

	beforeEach(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-startup-"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		removeSyncWithRetries(workDir);
	});

	it("returns promptly when a configured MCP server stalls on initialize", async () => {
		const manager = new MCPManager(workDir);
		const config: MCPStdioServerConfig = {
			type: "stdio",
			command: BUN_EXEC,
			args: [FIXTURE_PATH],
		};

		try {
			const start = performance.now();
			const result = await manager.connectServers({ hang: config }, {});
			const elapsedMs = performance.now() - start;

			// `STARTUP_TIMEOUT_MS` is 250 ms; allow headroom for process spawn and
			// scheduling jitter while still proving startup stays near that window.
			expect(elapsedMs).toBeLessThan(2_000);

			// Slow server with no cached tools surfaces no tools at startup
			// and no error (it's still pending in the background). The fact
			// that startup returned at all is the contract.
			expect(result.tools).toEqual([]);
			expect(result.connectedServers).toEqual([]);
			expect(result.errors.has("hang")).toBe(false);

			// Manager retains the pending connection so reconnect/dedup logic
			// continues to function — a second `connectServers` call must not
			// double-spawn while the first is still in flight.
			const second = await manager.connectServers({ hang: config }, {});
			expect(second.tools).toEqual([]);
			expect(second.errors.has("hang")).toBe(false);
		} finally {
			await manager.disconnectAll();
		}
	}, 15_000);

	it("disconnectAll aborts a stalled handshake and terminates its fixture process", async () => {
		const manager = new MCPManager(workDir);
		const pidFile = path.join(workDir, "mcp.pid");
		const config: MCPStdioServerConfig = {
			type: "stdio",
			command: BUN_EXEC,
			args: [FIXTURE_PATH],
			env: { OMP_TEST_PID_FILE: pidFile },
		};

		const waitForFile = async (file: string): Promise<void> => {
			const deadline = Date.now() + 3_000;
			while (!fs.existsSync(file) && Date.now() < deadline) {
				// The fixture is an external process; its filesystem marker is
				// the synchronization signal available to this integration test.
				await Bun.sleep(10);
			}
			expect(fs.existsSync(file)).toBe(true);
		};

		try {
			await manager.connectServers({ hang: config }, {});
			await waitForFile(pidFile);

			const start = performance.now();
			await manager.disconnectAll();
			const elapsedMs = performance.now() - start;
			expect(elapsedMs).toBeLessThan(2_000);
			const pid = Number(await Bun.file(pidFile).text());
			const deadline = Date.now() + 3_000;
			while (Date.now() < deadline) {
				try {
					process.kill(pid, 0);
				} catch {
					return;
				}
				// Process exit is observable only through the OS; poll briefly
				// after teardown to ensure no fixture child survives.
				await Bun.sleep(10);
			}
			expect(() => process.kill(pid, 0)).toThrow();
		} finally {
			await manager.disconnectAll();
		}
	}, 10_000);

	it("does not publish tools from a reconnect invalidated during tools/list", async () => {
		const manager = new MCPManager(workDir);
		const config: MCPStdioServerConfig = {
			type: "stdio",
			command: "mock-server",
		};
		const initialClose = vi.fn(async () => {});
		const reconnectClose = vi.fn(async () => {});
		const initial: MCPServerConnection = {
			name: "reconnectable",
			config,
			transport: {
				connected: true,
				request: async <T>() => undefined as T,
				notify: async () => {},
				close: initialClose,
				onClose: undefined,
			},
			serverInfo: { name: "initial", version: "1.0.0" },
			capabilities: { tools: {} },
		};
		const reconnect: MCPServerConnection = {
			...initial,
			transport: {
				connected: true,
				request: async <T>() => undefined as T,
				notify: async () => {},
				close: reconnectClose,
				onClose: undefined,
			},
			serverInfo: { name: "reconnect", version: "1.0.0" },
		};
		const reconnectStarted = Promise.withResolvers<void>();
		const toolsStarted = Promise.withResolvers<void>();
		const retiredTools = Promise.withResolvers<MCPToolDefinition[]>();
		let connectCount = 0;
		const connectToServer = vi.spyOn(mcpClient, "connectToServer").mockImplementation(async () => {
			connectCount++;
			if (connectCount === 1) return initial;
			reconnectStarted.resolve();
			return reconnect;
		});
		vi.spyOn(mcpClient, "listTools")
			.mockResolvedValueOnce([])
			.mockImplementationOnce(async () => {
				toolsStarted.resolve();
				return retiredTools.promise;
			});
		const toolsChanged = vi.fn();
		manager.setOnToolsChanged(toolsChanged);

		try {
			await manager.connectServers({ reconnectable: config }, {});
			const initialNotifications = toolsChanged.mock.calls.length;

			const reconnecting = manager.reconnectServer("reconnectable");
			await reconnectStarted.promise;
			await toolsStarted.promise;

			await manager.disconnectAll();
			retiredTools.resolve([{ name: "retired-tool", inputSchema: { type: "object" } }]);

			expect(await reconnecting).toBeNull();
			expect(toolsChanged).toHaveBeenCalledTimes(initialNotifications);
			expect(manager.getTools()).toEqual([]);
			expect(manager.getConnection("reconnectable")).toBeUndefined();
			expect(reconnectClose).toHaveBeenCalled();
			expect(connectToServer).toHaveBeenCalledTimes(2);
		} finally {
			await manager.disconnectAll();
		}
	});

	it("closes a connection that finishes after its manager is disconnected", async () => {
		const manager = new MCPManager(workDir);
		const config: MCPStdioServerConfig = {
			type: "stdio",
			command: "late-server",
		};
		const transport = {
			connected: true,
			request: async <T>() => undefined as T,
			notify: async () => {},
			close: async () => {},
			onClose: undefined,
		};
		const connection: MCPServerConnection = {
			name: "late",
			config,
			transport,
			serverInfo: { name: "late", version: "1.0.0" },
			capabilities: {},
		};
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<MCPServerConnection>();
		vi.spyOn(mcpClient, "connectToServer").mockImplementation(() => {
			started.resolve();
			return release.promise;
		});
		const listTools = vi.spyOn(mcpClient, "listTools").mockResolvedValue([]);
		const disconnectServer = vi.spyOn(mcpClient, "disconnectServer").mockResolvedValue();

		const connecting = manager.connectServers({ late: config }, {});
		const outcome: Promise<unknown> = connecting.then(
			() => undefined,
			error => error,
		);
		await started.promise;
		const disconnecting = manager.disconnectAll();
		release.resolve(connection);
		const [failure] = await Promise.all([outcome, disconnecting]);
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toContain("MCP discovery was superseded by manager teardown");

		expect(disconnectServer).toHaveBeenCalledWith(connection);
		expect(listTools).not.toHaveBeenCalled();
		expect(manager.getConnectionStatus("late")).toBe("disconnected");
	});
});
