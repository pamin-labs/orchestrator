import { i18n } from "@lingui/core";
import { compileMessage } from "@lingui/message-utils/compileMessage";
import zh from "./locales/zh.json";

/** The catalog on disk carries the English source beside each hashed id; the
 *  runtime wants only `{id: translation}`. */
const messages = (catalog: Record<string, { translation?: string }>): Record<string, string> => {
  const out: Record<string, string> = {};
  // An empty translation is a message nobody has done yet: leaving it out is
  // what makes the source text render instead of a blank pane.
  for (const [id, m] of Object.entries(catalog)) if (m.translation) out[id] = m.translation;
  return out;
};

/**
 * The panel's catalogs, raw. `@lingui/core` takes uncompiled ICU strings when a
 * compiler is registered, so `lingui compile` and its generated artefact never
 * exist — `build:web`, `bun test`, preflight, `browse.ts` and three workflows
 * would each have had to produce one first, and a fresh checkout that forgot
 * fails from inside a React component.
 */
/**
 * A leaf module on purpose: `@lingui/core` and the catalogs, nothing from `ui/`
 * or `shared/`. `test/web/module-graph.test.ts` fails on a cycle between panel
 * modules, and PR #9's third commit exists because its i18n folder imported
 * `ui/segment` while `shared/select.ts` imported i18n.
 */
i18n.setMessagesCompiler(compileMessage);
i18n.load("zh", messages(zh));
i18n.activate("zh");

export { i18n };
