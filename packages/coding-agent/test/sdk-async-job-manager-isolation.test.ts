import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { BashToolDetails } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

describe("AsyncJobManager session ownership", () => {
	const tempDirs: string[] = [];
	let sharedTempDir: string;
	let sharedAuthStorage: AuthStorage;
	let sharedModelRegistry: ModelRegistry;

	beforeAll(async () => {
		sharedTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sdk-async-isolation-shared-"));
		sharedAuthStorage = await AuthStorage.create(path.join(sharedTempDir, "auth.db"));
		sharedModelRegistry = new ModelRegistry(sharedAuthStorage, path.join(sharedTempDir, "models.yml"));
	});

	afterAll(() => {
		sharedAuthStorage.close();
		removeSyncWithRetries(sharedTempDir);
	});

	afterEach(() => {
		for (const tempDir of tempDirs.splice(0)) {
			removeSyncWithRetries(tempDir);
		}
	});

	async function spawnTopLevelSession(asyncJobManager?: AsyncJobManager) {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-async-isolation-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, `project-${Snowflake.next()}`);
		const agentDir = path.join(tempDir, "agent");
		fs.mkdirSync(cwd, { recursive: true });
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			settings: Settings.isolated({
				"async.enabled": true,
				"bash.autoBackground.enabled": true,
			}),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			modelRegistry: sharedModelRegistry,
			asyncJobManager,
		});
		return session;
	}

	it("keeps async-capable tool jobs inside their creating SDK session", async () => {
		const primary = await spawnTopLevelSession();
		const secondary = await spawnTopLevelSession();
		const primaryManager = primary.asyncJobManager;
		const secondaryManager = secondary.asyncJobManager;
		const primaryBash = primary.getToolByName("bash");
		const secondaryBash = secondary.getToolByName("bash");
		expect(primaryManager).toBeDefined();
		expect(secondaryManager).toBeDefined();
		expect(secondaryManager).not.toBe(primaryManager);
		if (!primaryManager || !secondaryManager || !primaryBash || !secondaryBash) {
			throw new Error("Expected isolated async managers and bash tools");
		}

		const executable = JSON.stringify(process.execPath);
		const primaryCommand = `${executable} -e "console.log('primary-sdk-job'); await Bun.sleep(30000)"`;
		const secondaryCommand = `${executable} -e "console.log('secondary-sdk-job'); await Bun.sleep(30000)"`;
		const [primaryResult, secondaryResult] = await Promise.all([
			primaryBash.execute("primary-async-bash", { command: primaryCommand, async: true, timeout: 0 }),
			secondaryBash.execute("secondary-async-bash", { command: secondaryCommand, async: true, timeout: 0 }),
		]);
		const primaryJobId = (primaryResult.details as BashToolDetails | undefined)?.async?.jobId;
		const secondaryJobId = (secondaryResult.details as BashToolDetails | undefined)?.async?.jobId;
		if (!primaryJobId || !secondaryJobId) throw new Error("Expected bash to start managed async jobs");

		try {
			expect(primary.getAsyncJobSnapshot()?.running.map(job => job.id)).toContain(primaryJobId);
			expect(secondary.getAsyncJobSnapshot()?.running.map(job => job.id)).toContain(secondaryJobId);
			expect(primaryManager.getJob(primaryJobId)?.label).toContain("primary-sdk-job");
			expect(secondaryManager.getJob(secondaryJobId)?.label).toContain("secondary-sdk-job");
			expect(primaryManager.getJob(primaryJobId)).not.toBe(secondaryManager.getJob(secondaryJobId));

			await secondary.dispose();

			expect(primaryManager.getJob(primaryJobId)?.status).toBe("running");
		} finally {
			primaryManager.cancel(primaryJobId);
			secondaryManager.cancel(secondaryJobId);
			await primaryManager.waitForAll();
			await primary.dispose();
			await secondary.dispose();
		}
	}, 60000);

	it("does not dispose a manager borrowed by a session", async () => {
		const deliveries: string[] = [];
		const manager = new AsyncJobManager({
			onJobComplete: jobId => {
				deliveries.push(jobId);
			},
			retentionMs: 0,
		});
		const borrower = await spawnTopLevelSession(manager);
		expect(borrower.asyncJobManager).toBe(manager);

		await borrower.dispose();

		const jobId = manager.register("bash", "still usable", async () => "completed", { ownerId: "external" });
		await manager.waitForAll();
		expect(deliveries).toEqual([jobId]);
		await manager.dispose({ timeoutMs: 200 });
	}, 60000);
	it("disposes the internally owned manager when session startup fails", async () => {
		const dispose = spyOn(AsyncJobManager.prototype, "dispose");
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-async-owned-failure-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, `project-${Snowflake.next()}`);
		const agentDir = path.join(tempDir, "agent");
		fs.mkdirSync(cwd, { recursive: true });

		try {
			await expect(
				createAgentSession({
					cwd,
					agentDir,
					settings: Settings.isolated({ "async.enabled": true }),
					disableExtensionDiscovery: true,
					skills: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
					enableMCP: false,
					enableLsp: false,
					modelRegistry: sharedModelRegistry,
					systemPrompt: () => {
						throw new Error("forced owned startup failure");
					},
				}),
			).rejects.toThrow("forced owned startup failure");

			expect(dispose).toHaveBeenCalledTimes(1);
			expect(dispose).toHaveBeenCalledWith({ timeoutMs: 3_000 });
		} finally {
			dispose.mockRestore();
		}
	}, 60000);

	it("leaves an injected manager usable after session startup fails", async () => {
		const deliveries: string[] = [];
		const manager = new AsyncJobManager({
			onJobComplete: jobId => {
				deliveries.push(jobId);
			},
			retentionMs: 0,
		});
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-async-startup-failure-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, `project-${Snowflake.next()}`);
		const agentDir = path.join(tempDir, "agent");
		fs.mkdirSync(cwd, { recursive: true });

		await expect(
			createAgentSession({
				cwd,
				agentDir,
				settings: Settings.isolated({ "bash.autoBackground.enabled": true }),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				modelRegistry: sharedModelRegistry,
				asyncJobManager: manager,
				systemPrompt: () => {
					throw new Error("forced startup failure");
				},
			}),
		).rejects.toThrow("forced startup failure");

		const jobId = manager.register("bash", "still usable", async () => "completed", { ownerId: "external" });
		await manager.waitForAll();
		expect(deliveries).toEqual([jobId]);
		await manager.dispose({ timeoutMs: 200 });
	}, 60000);
});
