import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { parseInternalUrl, SkillProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

async function withSkill<T>(fn: (skill: Skill, root: string) => Promise<T>): Promise<T> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-protocol-"));
	const baseDir = path.join(root, "demo");
	const filePath = path.join(baseDir, "SKILL.md");
	await fs.mkdir(baseDir, { recursive: true });
	await Bun.write(filePath, "# Demo\n");
	const skill: Skill = {
		name: "demo",
		description: "test skill",
		filePath,
		baseDir,
		source: "test",
	};
	try {
		return await fn(skill, root);
	} finally {
		await removeWithRetries(root);
	}
}

describe("SkillProtocolHandler", () => {
	it("rejects raw and encoded traversal before URL normalization", async () => {
		await withSkill(async skill => {
			const handler = new SkillProtocolHandler();
			const context = { skills: [skill] };

			await expect(handler.resolve(parseInternalUrl("skill://demo/../escape"), context)).rejects.toThrow(
				"Path traversal (..) is not allowed in skill:// URLs",
			);
			await expect(handler.resolve(parseInternalUrl("skill://demo/%2E%2E/escape"), context)).rejects.toThrow(
				"Path traversal (..) is not allowed in skill:// URLs",
			);
		});
	});

	it("redacts the backing path from missing-resource errors", async () => {
		await withSkill(async (skill, root) => {
			const handler = new SkillProtocolHandler();
			const input = "skill://demo/missing.txt";
			const error = await handler.resolve(parseInternalUrl(input), { skills: [skill] }).catch(error => error);

			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toBe(`File not found: ${input}`);
			expect((error as Error).message).not.toContain(root);
		});
	});
});
