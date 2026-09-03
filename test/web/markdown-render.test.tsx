import { afterEach, expect, test } from "bun:test";
import { cleanup, render as mount } from "../support/render.tsx";
import { Markdown } from "../../web/src/ui/markdown.tsx";
import { WithAttachments } from "../../web/src/ui/attachments.tsx";

/**
 * What an agent wrote, drawn as the document it is.
 *
 * Agent output is Markdown by ADR 016 and the panel showed the source: a plan
 * card reached the boss as `## Goal` over a column of `-`, and a timeline entry
 * quoting a table reached them as `| --- |`. Every assertion here is a count or a
 * property, never a node — `test/support/render.tsx` says why.
 */

afterEach(cleanup);

const html = (source: string): string => mount(<Markdown source={source} />).container.innerHTML;

test("headings, lists and tables are elements, not the characters that spell them", () => {
  const card = "## Goal\n\nShip it.\n\n- one\n- two\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n";
  const out = html(card);
  expect(out).toContain("<h2>Goal</h2>");
  // Two, because a list that renders as one paragraph per line is the shape this
  // caught: `<li>` present is not enough.
  expect(out.match(/<li>/g)?.length).toBe(2);
  expect(out).toContain("<table>");
  expect(out).not.toContain("## Goal");
});

test("raw HTML an agent wrote is escaped, not run", () => {
  // The trust boundary: this text came from a model over the mailbox and is
  // rendered through `dangerouslySetInnerHTML`. `html: false` is what makes that
  // safe, and nothing else in the file would fail if it were flipped.
  const out = html('<img src=x onerror="alert(1)"> and <script>alert(2)</script>');
  expect(out).not.toContain("<img");
  expect(out).not.toContain("<script");
  expect(out).toContain("&lt;script&gt;");
});

test("a javascript: link is refused and a real one leaves the panel", () => {
  // markdown-it's own `validateLink` refuses the href and leaves the source text
  // standing, so the assertion is that no anchor was made — not that the string
  // is absent, which it is not.
  expect(html("[click](javascript:alert(1))")).not.toContain("<a ");
  const out = html("see https://example.com/x for the log");
  expect(out).toContain('href="https://example.com/x"');
  expect(out).toContain('target="_blank"');
  expect(out).toContain('rel="noreferrer"');
});

test("the surface every timeline bubble and note goes through renders it too", () => {
  // `WithAttachments` is the one read-only entry point — the timeline's `Asked`
  // and the notes list both call it — so the fix belongs there rather than at
  // each caller.
  const out = mount(<WithAttachments body={"**bold** and `code`"} />).container.innerHTML;
  expect(out).toContain("<strong>bold</strong>");
  expect(out).toContain("<code>code</code>");
});

test("a fenced block is highlighted, and an unknown language is still escaped", () => {
  // The editor's preview highlights through its own bundled Prism; this half runs
  // highlight.js behind markdown-it's documented `highlight` hook, and the two
  // read one palette. Without it a code fence in an agent's answer is a grey slab.
  const out = html("```ts\nconst x = 1;\n```\n");
  expect(out).toContain('<code class="language-ts">');
  expect(out).toContain("hljs-keyword");
  // Declining is `""`, which hands the fence back to markdown-it to escape — the
  // path that matters, because an agent naming a language nobody bundled is
  // ordinary and must not render as markup.
  const plain = html("```nosuchlang\n<b>x</b>\n```\n");
  expect(plain).toContain("&lt;b&gt;");
  expect(plain).not.toContain("<b>");
});

test("a newline an agent wrote as two characters is still repaired", () => {
  // `nl()` predates this and had to survive the change: models emit a literal
  // backslash-n inside strings they think they are quoting.
  expect(html("first\\nsecond")).toContain("<br>");
});
