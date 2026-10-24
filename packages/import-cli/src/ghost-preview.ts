import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { Unzip, UnzipInflate } from "fflate";
import {
	buildJoinIndex,
	buildTagLookup,
	buildUserLookup,
	ghostPostType,
	lexicalToHtml,
	parseGhostExport,
} from "@plugdash/fromghost/export";
import { convertGhostMarkdown } from "./ghost-markdown.ts";

export interface PreviewOptions {
	file: string;
	output: string;
	siteUrl?: string;
	/** Total compressed input and expanded archive limit. Default 512 MiB. */
	maxBytes?: number;
}

const DEFAULT_LIMIT = 512 * 1024 * 1024;
const ENTRY_LIMIT = 64 * 1024 * 1024;
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function readArchive(bytes: Uint8Array, limit: number) {
	const files = new Map<string, Buffer>();
	const duplicateEntries: string[] = [];
	let total = 0;
	let count = 0;
	let pending = 0;
	const unzip = new Unzip((entry) => {
		if (++count > 20000) throw new Error("Archive entry count limit exceeded");
		const name = entry.name;
		if (
			!name ||
			name.startsWith("/") ||
			name.includes("\\") ||
			name.includes(":") ||
			Array.from(name).some((char) => char.charCodeAt(0) < 32) ||
			name.split("/").some((part) => part === ".." || part === ".")
		) {
			throw new Error(`Unsafe archive path: ${name}`);
		}
		if (name.endsWith("/")) return;
		if ((entry.originalSize ?? 0) > Math.min(limit, ENTRY_LIMIT))
			throw new Error(`Archive entry size limit exceeded: ${name}`);
		const chunks: Uint8Array[] = [];
		let size = 0;
		pending++;
		entry.ondata = (error, chunk, final) => {
			if (error) throw error;
			total += chunk.length;
			size += chunk.length;
			if (total > limit || size > Math.min(limit, ENTRY_LIMIT))
				throw new Error("Archive expanded size limit exceeded");
			chunks.push(chunk);
			if (final) {
				pending--;
				const data = Buffer.concat(chunks);
				const previous = files.get(name);
				if (previous) {
					if (!previous.equals(data))
						throw new Error(`Conflicting duplicate archive entry: ${name}`);
					duplicateEntries.push(name);
				} else files.set(name, data);
			}
		};
		entry.start();
	});
	unzip.register(UnzipInflate);
	for (let offset = 0; offset < bytes.length; offset += 16384) {
		unzip.push(bytes.subarray(offset, offset + 16384), offset + 16384 >= bytes.length);
	}
	if (pending) throw new Error("Incomplete ZIP archive");
	return { files, duplicateEntries };
}

async function assertAbsent(path: string) {
	try {
		await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	throw new Error(`Output already exists: ${path}`);
}

export async function exportGhostPreview(options: PreviewOptions) {
	const limit = options.maxBytes ?? DEFAULT_LIMIT;
	if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("Invalid size limit");
	const output = resolve(options.output);
	await assertAbsent(output);
	if ((await stat(options.file)).size > limit) throw new Error("Input size limit exceeded");
	const bytes = await readFile(options.file);
	const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
	const { files, duplicateEntries } = isZip
		? readArchive(bytes, limit)
		: { files: new Map<string, Buffer>(), duplicateEntries: [] as string[] };
	const input = isZip ? files.get("export.json") : bytes;
	if (!input) throw new Error("Ghost ZIP must contain export.json at its root");
	const { version, data } = parseGhostExport(JSON.parse(input.toString("utf8")));
	const tags = buildTagLookup(data.tags);
	const users = buildUserLookup(data.users);
	const tagsByPost = buildJoinIndex(data.posts_tags, "tag_id");
	const authorsByPost = buildJoinIndex(data.posts_authors, "author_id");
	const warnings: { ghostId: string; message: string }[] = [];
	const unresolvedImages: { ghostId: string; url: string; reason: string }[] = [];
	const media = new Map<
		string,
		{ file: string; sources: string[]; bytes: number; sha256: string }
	>();
	const mediaBytes = new Map<string, Buffer>();
	const entries: Record<string, unknown>[] = [];
	const generated = new Map<string, string>();
	const seenIds = new Set<string>();
	const slugs = new Set<string>();
	const counts = {
		posts: 0,
		pages: 0,
		published: 0,
		drafts: 0,
		otherStatuses: 0,
		mediaFiles: 0,
		images: 0,
		iframes: 0,
		tables: 0,
		codeBlocks: 0,
	};
	const siteUrl = options.siteUrl ? new URL(options.siteUrl) : undefined;
	if (siteUrl && !["http:", "https:"].includes(siteUrl.protocol))
		throw new Error("siteUrl must be an HTTP(S) URL");
	for (const [index, post] of data.posts.entries()) {
		const ghostId = post.id ?? `row-${index + 1}`;
		if (seenIds.has(ghostId)) throw new Error(`Duplicate Ghost ID: ${ghostId}`);
		seenIds.add(ghostId);
		const kind = ghostPostType(post);
		const safeId = hash(ghostId).slice(0, 24);
		const file = `${kind === "page" ? "pages" : "posts"}/${safeId}.md`;
		const original = `originals/${safeId}.json`;
		const warn = (message: string) => warnings.push({ ghostId, message });
		const slugKey = `${kind}:${post.slug ?? ""}`;
		if (!post.slug || slugs.has(slugKey))
			warn("Missing or duplicate slug; review before importing.");
		slugs.add(slugKey);
		const references: { url: string; file?: string }[] = [];
		const resolveImage = (url: string) => {
			let path: string | undefined;
			let reason = "Image is not present in the ZIP";
			try {
				const placeholder = url.startsWith("__GHOST_URL__");
				const relative = !/^[a-z][a-z\d+.-]*:/i.test(url) && !url.startsWith("//");
				const parsed = new URL(
					placeholder ? url.replace("__GHOST_URL__", "https://ghost.invalid") : url,
					siteUrl ?? "https://ghost.invalid",
				);
				const sameSite = placeholder || relative || (siteUrl && parsed.origin === siteUrl.origin);
				if (sameSite) {
					path = decodeURIComponent(parsed.pathname).replace(/^\/+/, "");
					// Ghost /size/wNNN/ URLs refer to the same original under content/images.
					path = path.replace(
						/^content\/images\/size\/(?:w\d+|h\d+|w\d+h\d+)\//,
						"content/images/",
					);
				} else
					reason =
						"External URL; no network requests are made (pass --site-url to identify the old site)";
			} catch {
				reason = "Invalid image URL";
			}
			const image = path?.startsWith("content/images/") ? files.get(path) : undefined;
			if (!image) {
				unresolvedImages.push({ ghostId, url, reason });
				references.push({ url });
				return url;
			}
			const sha256 = hash(image);
			const ext = extname(path!).toLowerCase();
			const safeExt = /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : ".bin";
			const target = `media/${sha256}${safeExt}`;
			const previous = media.get(target);
			if (previous) {
				if (!previous.sources.includes(path!)) previous.sources.push(path!);
			} else {
				media.set(target, { file: target, sources: [path!], bytes: image.length, sha256 });
				mediaBytes.set(target, image);
			}
			references.push({ url, file: target });
			return `../${target}`;
		};
		let html = post.html?.trim() ?? "";
		if (!html && post.lexical) {
			html = lexicalToHtml(post.lexical) ?? "";
			warn(
				html
					? "No rendered HTML: recovered plain text from Lexical; formatting/cards may be lost."
					: "Empty or unsupported Lexical body; check the preserved original.",
			);
		} else if (!html && post.mobiledoc) warn("Mobiledoc without rendered HTML is unsupported.");
		const converted = convertGhostMarkdown(html, { siteUrl: options.siteUrl, resolveImage });
		for (const message of converted.warnings) warn(message);
		if (!converted.markdown.trim()) warn("Empty Markdown body.");
		for (const key of ["images", "iframes", "tables", "codeBlocks"] as const)
			counts[key] += converted.stats[key];
		counts[kind === "page" ? "pages" : "posts"]++;
		counts[
			post.status === "published"
				? "published"
				: post.status === "draft"
					? "drafts"
					: "otherStatuses"
		]++;
		const cover = post.feature_image ? resolveImage(post.feature_image) : undefined;
		entries.push({
			ghostId,
			slug: post.slug,
			title: post.title,
			type: kind,
			status: post.status ?? "draft",
			visibility: post.visibility ?? "public",
			createdAt: post.created_at,
			updatedAt: post.updated_at,
			publishedAt: post.published_at,
			description: post.custom_excerpt || post.excerpt || undefined,
			seo: { title: post.meta_title, description: post.meta_description },
			tags: (tagsByPost.get(ghostId) ?? [])
				.map((id) => tags.get(id))
				.filter((tag) => tag && tag.visibility !== "internal")
				.map((tag) => tag!.slug ?? tag!.name),
			authors: (authorsByPost.get(ghostId) ?? [])
				.map((id) => users.get(id))
				.filter(Boolean)
				.map((user) => ({ slug: user!.slug, name: user!.name })),
			file,
			original,
			cover,
			images: references,
		});
		generated.set(file, converted.markdown);
		generated.set(
			original,
			json({
				html: post.html ?? null,
				lexical: post.lexical ?? null,
				mobiledoc: post.mobiledoc ?? null,
			}),
		);
	}
	counts.mediaFiles = media.size;
	const report = {
		version: 1,
		ghostVersion: version,
		counts,
		warnings,
		unresolvedImages,
		duplicateEntries,
	};
	generated.set(
		"manifest.json",
		json({ version: 1, ghostVersion: version, entries, media: [...media.values()] }),
	);
	generated.set("report.json", json(report));
	const parent = dirname(output);
	await mkdir(parent, { recursive: true });
	// mkdir is the exclusive reservation: even an existing empty directory is refused.
	await mkdir(output);
	const marker = join(output, ".incomplete");
	try {
		await writeFile(marker, "Preview is incomplete. Do not import these files.\n", { flag: "wx" });
		for (const [path, content] of [...generated.entries(), ...mediaBytes.entries()]) {
			await mkdir(dirname(join(output, path)), { recursive: true });
			await writeFile(join(output, path), content, { flag: "wx" });
		}
		await rm(marker);
	} catch (error) {
		// Only remove the exact absolute directory exclusively created above.
		if (resolve(output) === output && dirname(output) === parent && output !== parent) {
			await rm(output, { recursive: true, force: true }).catch(() => {
				// If Windows has locked a file, the .incomplete marker remains.
			});
		}
		throw error;
	}
	return report;
}
