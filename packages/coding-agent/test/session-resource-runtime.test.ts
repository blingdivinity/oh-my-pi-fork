import { describe, expect, it } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { ReloadResult } from "@oh-my-pi/pi-coding-agent/runtime";
import {
	SESSION_TOOL_CONTRIBUTION_PRIORITY,
	SessionResourceContributions,
} from "@oh-my-pi/pi-coding-agent/session/session-resource-contributions";
import {
	type SessionResourceCandidates,
	SessionResourceController,
	type SessionResourceDomain,
	type SessionResourceManifest,
	type SessionResourceValues,
} from "@oh-my-pi/pi-coding-agent/session/session-resource-runtime";
import { type } from "arktype";

function createTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: type({}),
		async execute() {
			return { content: [{ type: "text", text: name }] };
		},
	};
}

function createFixture(id: string): {
	readonly values: SessionResourceValues;
	readonly scopes: SessionResourceContributions["scopes"];
	readonly sessionScope: SessionResourceContributions["sessionScope"];
} {
	const contributions = new SessionResourceContributions({
		source: { kind: "session", id: `fixture-${id}` },
	});
	const tool = createTool(`fixture-tool-${id}`);
	contributions.addTool(tool, {
		source: { kind: "builtin-tool", id: `fixture-${id}` },
		priority: SESSION_TOOL_CONTRIBUTION_PRIORITY.builtin,
	});

	return {
		values: {
			providers: {
				authStorage: {} as SessionResourceValues["providers"]["authStorage"],
				modelRegistry: {} as SessionResourceValues["providers"]["modelRegistry"],
				model: undefined,
				thinkingLevel: undefined,
				serviceTierByFamily: {} as SessionResourceValues["providers"]["serviceTierByFamily"],
			},
			rules: {
				all: [],
				rulebook: [],
				alwaysApply: [],
				ttsrManager: {} as SessionResourceValues["rules"]["ttsrManager"],
			},
			skills: {
				items: [],
				warnings: [],
				reloadable: false,
				settings: {} as SessionResourceValues["skills"]["settings"],
			},
			extensions: {
				result: {
					extensions: [],
					errors: [],
					runtime: {} as SessionResourceValues["extensions"]["result"]["runtime"],
				},
				runner: {} as SessionResourceValues["extensions"]["runner"],
			},
			mcp: {
				ownership: "absent",
				manager: undefined,
				getServerInstructions: undefined,
				disconnectOwnedManager: undefined,
			},
			tools: {
				registry: contributions.resolveToolRegistry(),
				contributions: contributions.snapshot,
				initialNames: [tool.name],
				builtInNames: new Set([tool.name]),
				requestedNames: undefined,
				initialMountedXdevNames: [],
				xdevRegistry: undefined,
				createVibeTools: undefined,
				setActiveNames: () => undefined,
			},
			commands: {
				promptTemplates: [],
				slashCommands: [],
				customCommands: [],
			},
			instructions: {
				systemPrompt: [],
				contextFiles: [],
				rebuildSystemPrompt: async () => ({ systemPrompt: [] }),
				titleSystemPrompt: undefined,
			},
			agents: {
				advisorConfigs: [],
				advisorTools: [],
				advisorWatchdogPrompt: undefined,
				advisorContextPrompt: undefined,
				advisorSharedInstructions: undefined,
			},
			ui: {
				ownership: "borrowed",
				hasUI: false,
				setToolUIContext: () => undefined,
				rebindExtensionContext: () => undefined,
			},
		},
		scopes: contributions.scopes,
		sessionScope: contributions.sessionScope,
	};
}

function providerCandidate(value: SessionResourceValues["providers"], fingerprint: string): SessionResourceCandidates {
	return { providers: { value, fingerprint } };
}

const providerTransitiveDomains: readonly SessionResourceDomain[] = [
	"providers",
	"extensions",
	"mcp",
	"tools",
	"commands",
	"instructions",
	"agents",
	"ui",
];

describe("SessionResourceController declarative reload", () => {
	it("publishes changed fingerprints atomically and revises transitive resources", async () => {
		const fixture = createFixture("atomic");
		const controller = new SessionResourceController({
			values: fixture.values,
			scopes: fixture.scopes,
			sessionScope: fixture.sessionScope,
			discover: ({ current }) => providerCandidate(current.resources.providers.value, "providers:changed"),
		});
		const observed: SessionResourceManifest[] = [];
		const unsubscribe = controller.subscribe(manifestResult => {
			observed.push(manifestResult.manifest);
			expect(controller.current).toBe(manifestResult.manifest);
		});

		try {
			const previous = controller.current;
			const result = await controller.reload(["providers"]);

			expect(result.state).toBe("applied");
			expect(observed).toHaveLength(1);
			expect(result.manifest).toBe(observed[0]);
			expect(result.manifest.resources.providers.fingerprint).toBe("providers:changed");
			for (const domain of providerTransitiveDomains) {
				expect(result.manifest.resources[domain].revision).toBe(previous.resources[domain].revision + 1);
			}
			expect(result.manifest.resources.rules.revision).toBe(previous.resources.rules.revision);
			expect(result.manifest.resources.skills.revision).toBe(previous.resources.skills.revision);
		} finally {
			unsubscribe();
			await controller.dispose();
		}
	});

	it("returns unchanged and retains resource snapshots for an identical fingerprint", async () => {
		const fixture = createFixture("identical");
		const controller = new SessionResourceController({
			values: fixture.values,
			scopes: fixture.scopes,
			sessionScope: fixture.sessionScope,
			discover: ({ current }) =>
				providerCandidate(current.resources.providers.value, current.resources.providers.fingerprint),
		});

		try {
			const previous = controller.current;
			const result = await controller.reload(["providers"]);

			expect(result.state).toBe("unchanged");
			expect(result.manifest.resources.providers).toBe(previous.resources.providers);
			expect(result.manifest.resources.providers.revision).toBe(1);
			expect(result.manifest.effective).toBe(previous.effective);
			expect(controller.current).toBe(result.manifest);
		} finally {
			await controller.dispose();
		}
	});

	it("retains the prior manifest when discovery fails", async () => {
		const fixture = createFixture("failure");
		const failure = new Error("resource discovery failed");
		let discoveryCalls = 0;
		const controller = new SessionResourceController({
			values: fixture.values,
			scopes: fixture.scopes,
			sessionScope: fixture.sessionScope,
			discover: () => {
				discoveryCalls++;
				throw failure;
			},
		});

		try {
			const previous = controller.current;
			const result = await controller.reload(["providers"]);

			expect(discoveryCalls).toBe(1);
			expect(result.state).toBe("failed");
			expect(result.manifest).toBe(previous);
			expect(controller.current).toBe(previous);
			expect(result.diagnostics).toEqual([
				expect.objectContaining({
					severity: "error",
					domain: "providers",
					message: "resource discovery failed",
					cause: failure,
				}),
			]);
		} finally {
			await controller.dispose();
		}
	});

	it("does not carry a failed candidate into a later dependent reload", async () => {
		const fixture = createFixture("failed-candidate-reset");
		let discoveryCall = 0;
		let failCommit = true;
		const controller = new SessionResourceController({
			values: fixture.values,
			scopes: fixture.scopes,
			sessionScope: fixture.sessionScope,
			discover: ({ current }) => {
				discoveryCall++;
				if (discoveryCall === 1) {
					return {
						skills: {
							value: { ...current.effective.skills, reloadable: true },
							fingerprint: "skills:failed-candidate",
						},
					};
				}
				return {
					rules: {
						value: current.effective.rules,
						fingerprint: "rules:changed",
					},
				};
			},
			commit: () => {
				if (!failCommit) return;
				failCommit = false;
				throw new Error("facade commit failed");
			},
		});

		try {
			const failed = await controller.reload(["skills"]);
			expect(failed.state).toBe("failed");
			expect(controller.current.effective.skills.reloadable).toBe(false);

			const applied = await controller.reload(["rules"]);
			expect(applied.state).toBe("applied");
			expect(applied.manifest.effective.skills.reloadable).toBe(false);
			expect(applied.manifest.resources.skills.fingerprint).toBe("startup:skills");
		} finally {
			await controller.dispose();
		}
	});

	it("serializes concurrent reload discovery without overlapping calls", async () => {
		const fixture = createFixture("serialized");
		const firstStarted = Promise.withResolvers<void>();
		const resumeFirst = Promise.withResolvers<void>();
		let discoveryCalls = 0;
		let activeDiscoveries = 0;
		let maximumActiveDiscoveries = 0;
		const controller = new SessionResourceController({
			values: fixture.values,
			scopes: fixture.scopes,
			sessionScope: fixture.sessionScope,
			discover: async ({ current }) => {
				discoveryCalls++;
				const call = discoveryCalls;
				activeDiscoveries++;
				maximumActiveDiscoveries = Math.max(maximumActiveDiscoveries, activeDiscoveries);
				if (call === 1) {
					firstStarted.resolve();
					await resumeFirst.promise;
				}
				activeDiscoveries--;
				return providerCandidate(current.resources.providers.value, `providers:${call}`);
			},
		});

		try {
			const firstReload = controller.reload(["providers"]);
			await firstStarted.promise;
			const secondReload = controller.reload(["providers"]);

			expect(discoveryCalls).toBe(1);
			expect(maximumActiveDiscoveries).toBe(1);
			resumeFirst.resolve();
			const [firstResult, secondResult] = await Promise.all([firstReload, secondReload]);

			expect(discoveryCalls).toBe(2);
			expect(maximumActiveDiscoveries).toBe(1);
			expect(firstResult.state).toBe("applied");
			expect(secondResult.state).toBe("applied");
			expect(firstResult.manifest.resources.providers.fingerprint).toBe("providers:1");
			expect(secondResult.manifest.resources.providers.fingerprint).toBe("providers:2");
			expect(secondResult.manifest.resources.providers.revision).toBe(
				firstResult.manifest.resources.providers.revision + 1,
			);
		} finally {
			resumeFirst.resolve();
			await controller.dispose();
		}
	});

	it("captures and serializes concurrent replacements", async () => {
		const fixture = createFixture("replace-serialized");
		const firstStarted = Promise.withResolvers<void>();
		const resumeFirst = Promise.withResolvers<void>();
		let secondPrepared = false;
		const controller = new SessionResourceController({
			values: fixture.values,
			scopes: fixture.scopes,
			sessionScope: fixture.sessionScope,
		});

		try {
			const first = controller.replace("providers", fixture.values.providers, "providers:first", {
				prepare: async () => {
					firstStarted.resolve();
					await resumeFirst.promise;
				},
			});
			await firstStarted.promise;
			const second = controller.replace("providers", fixture.values.providers, "providers:second", {
				prepare: () => {
					secondPrepared = true;
				},
			});

			await Promise.resolve();
			expect(secondPrepared).toBe(false);
			expect(controller.desiredRevision).toBe(3);
			resumeFirst.resolve();
			const [firstResult, secondResult] = await Promise.all([first, second]);

			expect(firstResult.state).toBe("applied");
			expect(secondResult.state).toBe("applied");
			expect(firstResult.manifest.resources.providers.fingerprint).toBe("providers:first");
			expect(secondResult.manifest.resources.providers.fingerprint).toBe("providers:second");
		} finally {
			resumeFirst.resolve();
			await controller.dispose();
		}
	});

	it("holds ordinary admission behind extension publication until the new generation starts", async () => {
		const fixture = createFixture("extension-publication-fence");
		const events: string[] = [];
		const shutdownStarted = Promise.withResolvers<void>();
		const releaseShutdown = Promise.withResolvers<void>();
		const oldRunner = {
			deactivate: async () => {
				events.push("v1 session_shutdown");
				shutdownStarted.resolve();
				await releaseShutdown.promise;
			},
		};
		const nextRunner = {
			emitSessionStart: async () => {
				events.push("v2 session_start");
			},
			ordinary: () => {
				events.push("v2 ordinary");
			},
		};
		const controller = new SessionResourceController({
			values: {
				...fixture.values,
				extensions: {
					...fixture.values.extensions,
					runner: oldRunner as unknown as SessionResourceValues["extensions"]["runner"],
				},
			},
			scopes: fixture.scopes,
			sessionScope: fixture.sessionScope,
			discover: ({ current }) => ({
				extensions: {
					value: {
						...current.effective.extensions,
						runner: nextRunner as unknown as SessionResourceValues["extensions"]["runner"],
					},
					fingerprint: "extensions:v2",
					lifecycle: {
						retire: async previous => {
							await (previous.value.runner as unknown as typeof oldRunner).deactivate();
						},
					},
					afterPublish: () => nextRunner.emitSessionStart(),
				},
			}),
		});

		try {
			const reload = controller.reload(["extensions"]);
			await shutdownStarted.promise;

			let ordinaryHandled = false;
			const ordinaryAdmission = controller.admit().then(admission => {
				ordinaryHandled = true;
				nextRunner.ordinary();
				admission.release();
			});
			await Promise.resolve();
			expect(ordinaryHandled).toBe(false);

			releaseShutdown.resolve();
			await Promise.all([reload, ordinaryAdmission]);
			expect(events).toEqual(["v1 session_shutdown", "v2 session_start", "v2 ordinary"]);
		} finally {
			releaseShutdown.resolve();
			await controller.dispose();
		}
	});

	it("allows an awaited causal reload from extension publication", async () => {
		const fixture = createFixture("causal-publication-reload");
		let nestedResult: ReloadResult<SessionResourceManifest> | undefined;
		let controller: SessionResourceController;
		controller = new SessionResourceController({
			values: fixture.values,
			scopes: fixture.scopes,
			sessionScope: fixture.sessionScope,
			discover: ({ current }) => ({
				extensions: {
					value: current.effective.extensions,
					fingerprint: "extensions:published",
					afterPublish: async () => {
						nestedResult = await controller.replace("rules", current.effective.rules, "rules:causal-publication");
					},
				},
			}),
		});

		try {
			const result = await controller.reload(["extensions"]);
			expect(result.state).toBe("applied");
			expect(nestedResult?.state).toBe("applied");
			expect(controller.current.resources.rules.fingerprint).toBe("rules:causal-publication");
		} finally {
			await controller.dispose();
		}
	});

	it("restores configured lifecycles for unstaged dependent domains", async () => {
		const fixture = createFixture("default-lifecycle");
		const events: string[] = [];
		const controller = new SessionResourceController({
			values: fixture.values,
			scopes: fixture.scopes,
			sessionScope: fixture.sessionScope,
			lifecycles: {
				extensions: {
					prepare: () => {
						events.push("prepare:extensions");
					},
				},
			},
		});

		try {
			const result = await controller.replace("providers", fixture.values.providers, "providers:changed");

			expect(result.state).toBe("applied");
			expect(events).toContain("prepare:extensions");
		} finally {
			await controller.dispose();
		}
	});

	it("returns a failed result for a malformed controller domain", async () => {
		const fixture = createFixture("malformed-domain");
		const controller = new SessionResourceController({
			values: fixture.values,
			scopes: fixture.scopes,
			sessionScope: fixture.sessionScope,
		});

		try {
			const result = await controller.reload(["unknown" as SessionResourceDomain]);

			expect(result.state).toBe("failed");
			expect(result.manifest).toBe(controller.current);
			expect(result.diagnostics).toEqual([
				expect.objectContaining({
					domain: "unknown",
					severity: "error",
				}),
			]);
		} finally {
			await controller.dispose();
		}
	});

	it("aborts active discovery and rejects new admission when disposal begins", async () => {
		const fixture = createFixture("dispose");
		const discoveryStarted = Promise.withResolvers<void>();
		const controller = new SessionResourceController({
			values: fixture.values,
			scopes: fixture.scopes,
			sessionScope: fixture.sessionScope,
			discover: async ({ signal }) => {
				discoveryStarted.resolve();
				const aborted = Promise.withResolvers<void>();
				if (signal.aborted) {
					aborted.resolve();
				} else {
					signal.addEventListener("abort", () => aborted.resolve(), { once: true });
				}
				await aborted.promise;
				signal.throwIfAborted();
				return {};
			},
		});

		const reload = controller.reload();
		await discoveryStarted.promise;
		const disposal = controller.dispose();
		const result = await reload;

		expect(result.state).toBe("failed");
		expect(result.diagnostics[0]?.message).toBe("Session resource controller is disposed");
		await expect(controller.admit()).rejects.toThrow("Session resource controller is disposed");
		await expect(controller.reload()).rejects.toThrow("Session resource controller is disposed");
		await disposal;
	});
	it("aborts discovered candidates when cancellation wins before staging", async () => {
		const fixture = createFixture("candidate-cancelled");
		const cancellation = new AbortController();
		let abortCalls = 0;
		const controller = new SessionResourceController({
			values: fixture.values,
			scopes: fixture.scopes,
			sessionScope: fixture.sessionScope,
			discover: ({ current }) => {
				cancellation.abort(new Error("cancel after discovery"));
				return {
					providers: {
						value: current.effective.providers,
						fingerprint: "providers:cancelled",
						lifecycle: {
							abort: () => {
								abortCalls++;
							},
						},
					},
				};
			},
		});

		try {
			const result = await controller.reload(["providers"], cancellation.signal);
			expect(result.state).toBe("failed");
			expect(result.diagnostics[0]?.message).toBe("cancel after discovery");
			expect(abortCalls).toBe(1);
		} finally {
			await controller.dispose();
		}
	});

	it("aborts every untransferred candidate when normalization fails", async () => {
		const fixture = createFixture("candidate-normalization");
		let abortCalls = 0;
		const controller = new SessionResourceController({
			values: fixture.values,
			scopes: fixture.scopes,
			sessionScope: fixture.sessionScope,
			discover: () => ({
				mcp: {
					value: {
						ownership: "borrowed",
						manager: undefined,
						getServerInstructions: undefined,
						disconnectOwnedManager: undefined,
					} as unknown as SessionResourceValues["mcp"],
					fingerprint: "mcp:invalid",
					lifecycle: {
						abort: () => {
							abortCalls++;
						},
					},
				},
			}),
		});

		try {
			const result = await controller.reload(["mcp"]);
			expect(result.state).toBe("failed");
			expect(result.diagnostics[0]?.message).toContain("Borrowed MCP resources require");
			expect(abortCalls).toBe(1);
		} finally {
			await controller.dispose();
		}
	});

	it("aborts an unchanged discovered candidate exactly once", async () => {
		const fixture = createFixture("candidate-unchanged");
		let abortCalls = 0;
		const controller = new SessionResourceController({
			values: fixture.values,
			scopes: fixture.scopes,
			sessionScope: fixture.sessionScope,
			discover: ({ current }) => ({
				providers: {
					value: current.effective.providers,
					fingerprint: current.resources.providers.fingerprint,
					lifecycle: {
						abort: () => {
							abortCalls++;
						},
					},
				},
			}),
		});

		try {
			const result = await controller.reload(["providers"]);
			expect(result.state).toBe("unchanged");
			expect(abortCalls).toBe(1);
		} finally {
			await controller.dispose();
		}
	});

	it("aborts once when candidate preparation fails before runtime ownership transfer", async () => {
		const fixture = createFixture("candidate-prepare-failure");
		let abortCalls = 0;
		const controller = new SessionResourceController({
			values: fixture.values,
			scopes: fixture.scopes,
			sessionScope: fixture.sessionScope,
			discover: ({ current }) => ({
				providers: {
					value: current.effective.providers,
					fingerprint: "providers:prepare-failure",
					lifecycle: {
						prepare: () => {
							throw new Error("candidate prepare failed");
						},
						abort: () => {
							abortCalls++;
						},
					},
				},
			}),
		});

		try {
			const result = await controller.reload(["providers"]);
			expect(result.state).toBe("failed");
			expect(result.diagnostics.some(item => item.message === "candidate prepare failed")).toBe(true);
			expect(abortCalls).toBe(1);
		} finally {
			await controller.dispose();
		}
	});

	it("deeply snapshots rule, skill, warning, and settings records", async () => {
		const fixture = createFixture("immutable-records");
		const rule = {
			name: "typescript",
			path: "/rules/typescript.md",
			content: "Use TypeScript",
			globs: ["*.ts"],
			condition: ["typescript"],
			_source: {
				provider: "test",
				providerName: "Test",
				path: "/rules/typescript.md",
				level: "project" as const,
			},
		};
		const skill = {
			name: "review",
			description: "Review code",
			filePath: "/skills/review/SKILL.md",
			baseDir: "/skills/review",
			source: "project",
			_source: {
				provider: "test",
				providerName: "Test",
				path: "/skills/review/SKILL.md",
				level: "project" as const,
			},
		};
		const warning = { skillPath: "/skills/broken", message: "Broken skill" };
		const customDirectories = ["/skills/custom"];
		const controller = new SessionResourceController({
			values: {
				...fixture.values,
				rules: {
					...fixture.values.rules,
					all: [rule],
					rulebook: [rule],
					alwaysApply: [rule],
				},
				skills: {
					...fixture.values.skills,
					items: [skill],
					warnings: [warning],
					settings: { customDirectories },
				},
			},
			scopes: fixture.scopes,
			sessionScope: fixture.sessionScope,
		});

		try {
			const resources = controller.current.effective;
			const snapshottedRule = resources.rules.all[0]!;
			const snapshottedSkill = resources.skills.items[0]!;
			expect(snapshottedRule).toBe(resources.rules.rulebook[0]);
			expect(snapshottedRule).not.toBe(rule);
			expect(snapshottedSkill).not.toBe(skill);
			expect(Object.isFrozen(snapshottedRule)).toBe(true);
			expect(Object.isFrozen(snapshottedRule.globs)).toBe(true);
			expect(Object.isFrozen(snapshottedRule._source)).toBe(true);
			expect(Object.isFrozen(snapshottedSkill)).toBe(true);
			expect(Object.isFrozen(snapshottedSkill._source)).toBe(true);
			expect(Object.isFrozen(resources.skills.warnings[0])).toBe(true);
			expect(Object.isFrozen(resources.skills.settings.customDirectories)).toBe(true);

			rule.content = "mutated";
			rule.globs.push("*.js");
			skill.description = "mutated";
			warning.message = "mutated";
			customDirectories.push("/skills/other");
			expect(snapshottedRule.content).toBe("Use TypeScript");
			expect(snapshottedRule.globs).toEqual(["*.ts"]);
			expect(snapshottedSkill.description).toBe("Review code");
			expect(resources.skills.warnings[0]?.message).toBe("Broken skill");
			expect(resources.skills.settings.customDirectories).toEqual(["/skills/custom"]);
		} finally {
			await controller.dispose();
		}
	});
});
