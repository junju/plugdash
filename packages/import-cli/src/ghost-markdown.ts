import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

export interface MarkdownOptions {
	siteUrl?: string;
	resolveImage?: (url: string) => string;
}

export function convertGhostMarkdown(html: string, options: MarkdownOptions = {}) {
	const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
	const warnings: string[] = [];
	const stats = {
		images: document.querySelectorAll("img").length,
		iframes: document.querySelectorAll("iframe").length,
		tables: document.querySelectorAll("table").length,
		codeBlocks: document.querySelectorAll("pre").length,
	};
	const resolveLink = (url: string) => {
		if (url.startsWith("__GHOST_URL__")) {
			if (!options.siteUrl) warnings.push(`Unresolved Ghost link: ${url}`);
			return options.siteUrl
				? url.replace("__GHOST_URL__", options.siteUrl.replace(/\/+$/, ""))
				: url;
		}
		return url;
	};
	const safeUrl = (url: string) => {
		const normalized = Array.from(url)
			.filter((char) => char.charCodeAt(0) > 32)
			.join("");
		return !/^[a-z][a-z\d+.-]*:/i.test(normalized) || /^(?:https?|mailto|tel):/i.test(normalized);
	};
	for (const el of Array.from(
		document.querySelectorAll("script,style,form,input,button,svg,object"),
	)) {
		warnings.push(`Removed unsupported ${el.tagName.toLowerCase()} element; see original HTML.`);
		el.remove();
	}
	for (const el of Array.from(document.querySelectorAll("iframe,video,audio,embed"))) {
		const tag = el.tagName.toLowerCase();
		const url = resolveLink(
			el.getAttribute("src") ?? el.querySelector("source")?.getAttribute("src") ?? "",
		);
		warnings.push(`${tag} converted to a link; embedded playback/layout is not preserved.`);
		if (url && safeUrl(url)) {
			const p = document.createElement("p");
			const a = document.createElement("a");
			a.setAttribute("href", url);
			a.textContent = el.getAttribute("title") || `Open ${tag}`;
			p.appendChild(a);
			el.replaceWith(p);
		} else {
			warnings.push(`Missing or unsafe ${tag} URL; see original HTML.`);
			el.remove();
		}
	}
	for (const a of Array.from(document.querySelectorAll("a[href]"))) {
		const url = resolveLink(a.getAttribute("href")!);
		if (!safeUrl(url)) {
			warnings.push("Removed unsafe link URL.");
			a.removeAttribute("href");
		} else a.setAttribute("href", url);
	}
	for (const img of Array.from(document.querySelectorAll("img"))) {
		const src = img.getAttribute("src") ?? "";
		if (!src || !safeUrl(src)) {
			warnings.push("Image without a safe src was omitted; see original HTML.");
			img.replaceWith(document.createTextNode(img.getAttribute("alt") ?? ""));
			continue;
		}
		img.setAttribute("src", options.resolveImage?.(src) ?? src);
		// Markdown uses a single image; audit HTML retains all responsive variants.
		img.removeAttribute("srcset");
	}
	for (const table of Array.from(document.querySelectorAll("table"))) {
		if (!table.querySelector("tr")) {
			warnings.push("Empty table omitted.");
			table.remove();
			continue;
		}
		if (table.querySelector("[colspan],[rowspan],table")) {
			warnings.push("Complex table flattened to a Markdown table; verify against original HTML.");
		}
		const first = table.querySelector("tr");
		if (first && !first.querySelector("th")) {
			warnings.push("Table without a header uses its first row as a Markdown header.");
			for (const cell of Array.from(first.children)) {
				const header = document.createElement("th");
				header.innerHTML = cell.innerHTML;
				cell.replaceWith(header);
			}
		}
		for (const row of Array.from(table.querySelectorAll("tr"))) {
			for (const child of Array.from(row.childNodes)) {
				if (child.nodeType === 3 && !child.textContent?.trim()) child.remove();
			}
		}
	}
	for (const card of Array.from(document.querySelectorAll('[class*="kg-"]'))) {
		const cls = card.getAttribute("class") ?? "";
		if (/kg-(?:bookmark|callout|toggle|button|product|signup|header|gallery)-card/.test(cls)) {
			warnings.push(`Ghost card converted to basic Markdown; layout is not preserved: ${cls}`);
		}
	}
	const service = new TurndownService({
		headingStyle: "atx",
		codeBlockStyle: "fenced",
		bulletListMarker: "-",
	});
	service.use(gfm);
	service.addRule("strikethrough", {
		filter: (node) => ["DEL", "S", "STRIKE"].includes(node.nodeName),
		replacement: (content) => `~~${content}~~`,
	});
	service.addRule("tableCell", {
		filter: ["th", "td"],
		replacement: (content, node) =>
			`${(node as HTMLElement).previousElementSibling ? " " : "| "}${content.trim().replace(/\n+/g, " ").replace(/\|/g, "\\|")} |`,
	});
	service.addRule("image", {
		filter: "img",
		replacement: (_content, node) => {
			const alt = ((node as HTMLElement).getAttribute("alt") ?? "")
				.replace(/\\/g, "\\\\")
				.replace(/\[/g, "\\[")
				.replace(/\]/g, "\\]")
				.replace(/\s+/g, " ");
			const src = ((node as HTMLElement).getAttribute("src") ?? "")
				.replace(/\(/g, "%28")
				.replace(/\)/g, "%29")
				.replace(/[\s<>]/g, encodeURIComponent);
			return src ? `![${alt}](${src})` : alt;
		},
	});
	// GFM's table rules need the HTMLTableElement.rows API missing in linkedom.
	const markdown = service.turndown(document.body.innerHTML).trim();
	return { markdown: markdown ? `${markdown}\n` : "", warnings: [...new Set(warnings)], stats };
}
