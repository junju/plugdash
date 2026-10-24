import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { describe, expect, it } from "vitest";

const cli = resolve("packages/import-cli/src/cli.ts");
const run = (args: string[]) =>
	spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
		encoding: "utf8",
		env: { ...process.env, EMDASH_URL: "https://unreachable.invalid", EMDASH_TOKEN: "stale-token" },
	});

describe("Ghost offline CLI", () => {
	it("runs without credentials and ignores site environment variables", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ghost-cli-test-"));
		const file = join(dir, "export.json");
		const output = join(dir, "preview");
		await writeFile(
			file,
			JSON.stringify({
				data: { posts: [{ id: "p", slug: "p", html: "<p>Hello</p>", status: "draft" }] },
			}),
		);
		const result = run(["ghost", file, "--output", output]);
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
		expect(JSON.parse(await readFile(join(output, "report.json"), "utf8")).counts.posts).toBe(1);
		expect(run(["ghost", file, "--output", output]).status).toBe(1);
	});
	it("rejects site-import flags and unsupported sources before reading input", () => {
		for (const args of [
			["ghost", "missing.zip", "--output", "unused", "--publish"],
			["substack", "missing.zip", "--output", "unused"],
		]) {
			const result = run(args);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("--output");
			expect(result.stderr).not.toContain("ENOENT");
		}
	});
});
