import { describe, expect, it } from "vitest";
import { convertGhostMarkdown } from "../src/ghost-markdown.ts";

describe("Ghost HTML to Markdown", () => {
	it("handles empty tables, table pipes, strike marks and bracketed image alt text", () => {
		const result = convertGhostMarkdown(
			'<table></table><table><tr>\n<th>A</th>\n</tr><tr><td>a|b</td></tr></table><p><del>old</del><img src="https://example.com/a(b).png" alt="[photo]"></p>',
		);
		expect(result.markdown).toContain("a\\|b");
		expect(result.markdown).toContain("~~old~~");
		expect(result.markdown).toContain("![\\[photo\\]](https://example.com/a%28b%29.png)");
		expect(result.warnings).toContain("Empty table omitted.");
	});
	it("keeps headings, nested lists, fenced code, tables and image captions", () => {
		const result = convertGhostMarkdown(
			'<h2>日本語</h2><ul><li>first<ul><li>nested</li></ul></li></ul><pre><code class="language-js">a &lt; b</code></pre><table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table><figure><img src="__GHOST_URL__/content/images/a.png" alt="写真"><figcaption>caption</figcaption></figure>',
			{ resolveImage: () => "../media/a.png" },
		);
		expect(result.markdown).toContain("## 日本語");
		expect(result.markdown).toMatch(/\n\s+[-*] +nested/);
		expect(result.markdown).toContain("```js\na < b\n```");
		expect(result.markdown).toMatch(/\| A +\| B +\|/);
		expect(result.markdown).toContain("![写真](../media/a.png)");
		expect(result.markdown).toContain("caption");
		expect(result.stats).toEqual({ images: 1, iframes: 0, tables: 1, codeBlocks: 1 });
	});
	it("turns embeds into explicit links and reports complex tables", () => {
		const result = convertGhostMarkdown(
			'<iframe src="https://www.youtube.com/embed/example" title="Video"></iframe><table><tr><th colspan="2">A</th></tr><tr><td>x</td><td>y</td></tr></table>',
		);
		expect(result.markdown).toContain("[Video](https://www.youtube.com/embed/example)");
		expect(result.warnings.join(" ")).toMatch(/iframe/);
		expect(result.warnings.join(" ")).toMatch(/table/);
	});
	it("does not emit executable links or images and warns about removed elements", () => {
		const result = convertGhostMarkdown(
			'<a href="javascript:alert(1)">text</a><iframe src="javascript:alert(1)"></iframe><img src="data:text/html,bad"><script>bad()</script>',
		);
		expect(result.markdown).not.toMatch(/javascript:|data:|<script|bad\(\)/);
		expect(result.markdown).toContain("text");
		expect(result.warnings.length).toBeGreaterThan(0);
	});
	it("retains images inside paragraphs and replaces Ghost links when site URL is known", () => {
		const result = convertGhostMarkdown(
			'<p>before<img src="/content/images/a.png">after <a href="__GHOST_URL__/old-post/">link</a></p>',
			{ siteUrl: "https://old.example" },
		);
		expect(result.markdown).toContain("/content/images/a.png");
		expect(result.markdown).toContain("https://old.example/old-post/");
		expect(result.markdown).toContain("before");
		expect(result.markdown).toContain("after");
	});
});
