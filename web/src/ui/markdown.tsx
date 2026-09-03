import hljs from "highlight.js/lib/common";
import MarkdownIt from "markdown-it";
import { nl } from "../shared/prose";
import { cn } from "./cn";

/**
 * Markdown an agent wrote, rendered.
 *
 * Every card, journal entry and escalation is Markdown by ADR 016, and the panel
 * showed all of it as `whitespace-pre-wrap` source: `## Goal`, `| --- |` and a
 * column of `-` where the boss was meant to read a document and decide.
 */
/**
 * `html: false` is the trust boundary, not a preference. This text came out of a
 * model over the mailbox, and it is rendered into the panel through
 * `dangerouslySetInnerHTML`; with raw HTML disabled markdown-it escapes every
 * tag it meets, and its own `validateLink` already refuses `javascript:` and
 * `vbscript:` hrefs. `linkify` is on because agents write bare URLs, and
 * `breaks` because they write single newlines meaning them.
 */
/**
 * The `highlight` option is markdown-it's own documented hook, and returning `""`
 * from it is how its README says to decline: the fence is then escaped by the
 * renderer instead. `lib/common` is highlight.js's own subset entry — about forty
 * languages against the full build's near two hundred, and every language an
 * agent writes here is in it.
 */
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false,
  highlight: (code, lang) => (lang && hljs.getLanguage(lang) ? hljs.highlight(code, { language: lang }).value : ""),
});

/**
 * A link in the panel is a link out of it: without this the SPA navigates away
 * and the boss loses the timeline they were reading. `noreferrer` comes with
 * `_blank` — the rule the linter would write if it read generated HTML.
 */
md.renderer.rules.link_open = (tokens, i, opts, _env, self) => {
  tokens[i]?.attrSet("target", "_blank");
  tokens[i]?.attrSet("rel", "noreferrer");
  return self.renderToken(tokens, i, opts);
};

/**
 * `wmde-markdown` is the editor's own class, and that is deliberate: the preview
 * beside the plan card and the prose in the timeline are the same document in
 * two places, so they read from one set of rules mapped onto this panel's tokens
 * in `style.css`. `md-flow` is what makes it a paragraph in a bubble rather than
 * a page: transparent, inheriting size and colour from whatever it sits in.
 */
export function Markdown({ source, className }: { source: string; className?: string | undefined }) {
  return (
    <div
      className={cn("wmde-markdown md-flow break-words", className)}
      // fallow-ignore-next-line security-sink -- markdown-it's own output, and it is the sanitizer this rule asks for: `html: false` makes the parser escape every tag it meets rather than pass it through, and `validateLink` refuses `javascript:`, `vbscript:` and non-image `data:` hrefs. Both halves are held by `test/web/markdown-render.test.tsx`, which feeds it an `onerror` image and a `<script>` and asserts neither survives. DOMPurify would be a second owner for a decision the parser already makes.
      dangerouslySetInnerHTML={{ __html: md.render(nl(source)) }}
    />
  );
}
