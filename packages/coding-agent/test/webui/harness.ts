/**
 * Mock-model web-UI harness: boots a real AgentSession (deterministic mock
 * model) behind the SessionGateway + Bun.serve web server, serving the built
 * collab-web SPA. Shared by the browser e2e test and by `bun test/webui/harness.ts`
 * (run directly) for live, hands-on validation.
 */

import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SessionGateway } from "@oh-my-pi/pi-coding-agent/webui/gateway";
import { startWebServer } from "@oh-my-pi/pi-coding-agent/webui/server";
import { Snowflake, TempDir } from "@oh-my-pi/pi-utils";

/** Deterministic reply the mock model returns for every prompt. */
export const MOCK_REPLY = "Hello from the omp web UI.";

/** Built collab-web SPA directory the server serves. */
export function spaDir(): string {
	return path.resolve(import.meta.dir, "..", "..", "..", "collab-web", "dist");
}

export interface MockWebServer {
	url: string;
	token: string;
	port: number;
	stop: () => Promise<void>;
}

export async function startMockWebServer(options: { port?: number; reply?: string } = {}): Promise<MockWebServer> {
	const reply = options.reply ?? MOCK_REPLY;
	const tempDir = TempDir.createSync("@pi-web-e2e-");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("bundled model unavailable");
	// `handler` (not a fixed `responses` array) answers EVERY prompt the browser
	// sends, so the harness stays interactive across multiple turns.
	const mock = createMockModel({ handler: () => ({ content: [reply] }) });
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [] },
		streamFn: mock.stream,
	});
	const sessionManager = SessionManager.inMemory(tempDir.path());
	const settings = Settings.isolated({ "compaction.enabled": false });
	const authStorage = await AuthStorage.create(tempDir.join(`auth-${Snowflake.next()}.db`));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	const session = new AgentSession({ agent, sessionManager, settings, modelRegistry });

	const gateway = new SessionGateway({ session });
	gateway.start();
	const token = crypto.randomUUID();
	const server = startWebServer(gateway, { token, port: options.port ?? 0, host: "127.0.0.1", spaDir: spaDir() });

	return {
		url: `${server.url}#token=${token}`,
		token,
		port: server.port,
		stop: async () => {
			server.stop();
			gateway.stop();
			await session.dispose();
			authStorage.close();
			await tempDir.remove();
		},
	};
}

if (import.meta.main) {
	const server = await startMockWebServer({ port: 7878 });
	process.stdout.write(`\nMock omp web UI: ${server.url}\n(Ctrl+C to stop)\n`);
	process.on("SIGINT", () => {
		void server.stop().then(() => process.exit(0));
	});
}
