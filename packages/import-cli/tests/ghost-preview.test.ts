import { mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Zip, ZipPassThrough, strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { exportGhostPreview } from "../src/ghost-preview.ts";

const raw = {
	meta: { version: "6.73.0" },
	data: {
		posts: [
			{
				id: "../../unsafe",
				slug: "../slug",
				title: "記事",
				type: "post",
				status: "published",
				visibility: "public",
				html: '<p>Hello <img src="__GHOST_URL__/content/images/a.png"></p><iframe src="https://example.com/video"></iframe>',
				published_at: "2025-01-01T00:00:00Z",
				feature_image: "__GHOST_URL__/content/images/a.png",
			},
			{
				id: "draft",
				slug: "draft",
				status: "draft",
				type: "post",
				html: null,
				lexical: '{"root":{"children":[{"type":"paragraph","children":[]}]}}',
			},
			{ id: "page", slug: "about", type: "page", status: "published", html: "<p>About</p>" },
		],
		tags: [{ id: "t", slug: "tag", name: "Tag" }],
		posts_tags: [{ post_id: "../../unsafe", tag_id: "t" }],
		users: [{ id: "u", slug: "author", email: "private@example.com" }],
		settings: [{ key: "secret", value: "do not copy" }],
	},
};

async function setup(
	bytes = zipSync({
		"export.json": strToU8(JSON.stringify(raw)),
		"content/images/a.png": new Uint8Array([1, 2, 3]),
	}),
) {
	const dir = await mkdtemp(join(tmpdir(), "ghost-preview-test-"));
	const file = join(dir, "input.zip");
	await writeFile(file, bytes);
	return { dir, file, output: join(dir, "preview") };
}

describe("offline Ghost preview", () => {
	it("preserves metadata and separates pages, copies referenced images and retains originals", async () => {
		const options = await setup();
		const report = await exportGhostPreview(options);
		expect(report.counts).toMatchObject({
			posts: 2,
			pages: 1,
			published: 2,
			drafts: 1,
			mediaFiles: 1,
		});
		const manifest = JSON.parse(await readFile(join(options.output, "manifest.json"), "utf8"));
		expect(manifest.entries[0]).toMatchObject({
			ghostId: "../../unsafe",
			slug: "../slug",
			status: "published",
			tags: ["tag"],
			publishedAt: "2025-01-01T00:00:00Z",
		});
		expect(manifest.entries[0].file).not.toContain("unsafe");
		const body = await readFile(join(options.output, manifest.entries[0].file), "utf8");
		expect(body).toContain("../media/");
		expect(body).toContain("https://example.com/video");
		const audit = await readFile(join(options.output, manifest.entries[0].original), "utf8");
		expect(audit).toContain("<iframe");
		expect(JSON.stringify(manifest) + audit).not.toMatch(/private@example.com|do not copy/);
		expect(await readFile(join(options.output, manifest.media[0].file))).toEqual(
			Buffer.from([1, 2, 3]),
		);
		await expect(exportGhostPreview(options)).rejects.toThrow(/exist/);
	});
	it("supports JSON alone and reports unresolved images without fetching", async () => {
		const options = await setup();
		await writeFile(options.file, JSON.stringify(raw));
		const report = await exportGhostPreview(options);
		expect(report.counts.mediaFiles).toBe(0);
		expect(report.unresolvedImages.length).toBeGreaterThan(0);
	});
	it("rejects unsafe paths without creating output", async () => {
		const options = await setup(
			zipSync({ "export.json": strToU8(JSON.stringify(raw)), "../bad.png": strToU8("bad") }),
		);
		await expect(exportGhostPreview(options)).rejects.toThrow(/path/i);
		expect(await readdir(options.dir)).toEqual(["input.zip"]);
	});
	it("rejects bad JSON without publishing partial output", async () => {
		const options = await setup(zipSync({ "export.json": strToU8("broken") }));
		await expect(exportGhostPreview(options)).rejects.toThrow();
		expect(await readdir(options.dir)).toEqual(["input.zip"]);
	});
	it("rejects an inflated archive beyond configured bounds", async () => {
		const bytes = zipSync({
			"export.json": strToU8(JSON.stringify({ data: { posts: [{ html: "x".repeat(20000) }] } })),
		});
		expect(bytes.length).toBeLessThan(4096);
		const options = await setup(bytes);
		await expect(exportGhostPreview({ ...options, maxBytes: 4096 })).rejects.toThrow(/limit/i);
	});
	it("allows only one concurrent writer to reserve an output directory", async () => {
		const options = await setup();
		const results = await Promise.allSettled([
			exportGhostPreview(options),
			exportGhostPreview(options),
		]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect(
			JSON.parse(await readFile(join(options.output, "report.json"), "utf8")).counts.posts,
		).toBe(2);
		expect(await readdir(options.output)).not.toContain(".incomplete");
	});
	it("resolves Ghost resize paths and same-site URLs while retaining an external URL", async () => {
		const changed = JSON.parse(JSON.stringify(raw));
		changed.data.posts[0].html =
			'<img src="https://old.example/content/images/size/w1200/a.png"><img src="https://external.example/content/images/a.png">';
		const options = await setup(
			zipSync({
				"export.json": strToU8(JSON.stringify(changed)),
				"content/images/a.png": new Uint8Array([1, 2, 3]),
			}),
		);
		const report = await exportGhostPreview({ ...options, siteUrl: "https://old.example" });
		expect(report.counts.mediaFiles).toBe(1);
		expect(report.unresolvedImages).toHaveLength(1);
		expect(report.unresolvedImages[0]?.url).toContain("external.example");
	});
	it("records identical ZIP duplicates and rejects conflicting ones", async () => {
		function duplicateZip(other: string) {
			const chunks: Uint8Array[] = [];
			const zip = new Zip((error, chunk) => {
				if (error) throw error;
				chunks.push(chunk);
			});
			for (const [name, body] of [
				["export.json", JSON.stringify(raw)],
				["content/images/a.png", "same"],
				["content/images/a.png", other],
			]) {
				const file = new ZipPassThrough(name!);
				zip.add(file);
				file.push(strToU8(body!), true);
			}
			zip.end();
			return Buffer.concat(chunks);
		}
		const good = await setup(duplicateZip("same"));
		expect((await exportGhostPreview(good)).duplicateEntries).toContain("content/images/a.png");
		const bad = await setup(duplicateZip("different"));
		await expect(exportGhostPreview(bad)).rejects.toThrow(/conflict/i);
	});
});
