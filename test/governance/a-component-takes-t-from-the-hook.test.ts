import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { traverse, type NodePath } from "@babel/core";
import { parse } from "../support/ast.ts";

/**
 * Inside a component, `t` is the hook's.
 *
 * `@lingui/core/macro`'s `t` renders against the global instance and returns a
 * string, which does not change again. `@lingui/react/macro`'s `useLingui`
 * binds to the provider's, so the component re-renders when the locale moves —
 * this is what Lingui's own docs tell React code to use, and 103 call sites in
 * thirteen panes were on the other one.
 */
/**
 * A helper outside a component keeps the global `t` and that is not an
 * oversight: the macro only expands `useLingui` in a variable declaration, so a
 * plain function cannot have one. It is safe because the component that calls
 * it re-renders — except under `React.memo`, which is what
 * `translation-resubscribes.test.ts` covers.
 */
function offenders(file: string, source: string): string[] {
  const ast = parse(file, source);
  if (!ast) return [];
  const found: string[] = [];
  /** The outermost enclosing function, which is the component; anything nested
   *  is a callback inside it and shares its scope. */
  const componentAround = (p: NodePath): string => {
    let top = p.getFunctionParent();
    if (!top) return "";
    for (let up = top.getFunctionParent(); up; up = up.getFunctionParent()) top = up;
    return top.isFunctionDeclaration() && top.node.id
      ? top.node.id.name
      : top.parentPath?.isVariableDeclarator() && top.parentPath.node.id.type === "Identifier"
        ? top.parentPath.node.id.name
        : "";
  };

  traverse(ast, {
    // `i18n._(descriptor)` is the same finding one API over: it renders against
    // the global instance, so a component drawing a module-scope table through
    // it kept the old wording after a locale change.
    MemberExpression(p) {
      if (p.node.object.type !== "Identifier" || p.node.object.name !== "i18n") return;
      if (p.node.property.type !== "Identifier" || p.node.property.name !== "_") return;
      const named = componentAround(p);
      if (/^[A-Z]/.test(named)) found.push(`${file}:${p.node.loc?.start.line ?? 0} ${named} (i18n._)`);
    },
    Identifier(p) {
      if (p.node.name !== "t") return;
      const used =
        (p.parent.type === "TaggedTemplateExpression" && p.parent.tag === p.node) ||
        (p.parent.type === "CallExpression" && p.parent.callee === p.node);
      if (!used) return;
      // Bound by a `const { t } = useLingui()` somewhere above: that is the one
      // this test wants.
      if (p.scope.getBinding("t")?.path.isVariableDeclarator()) return;

      const named = componentAround(p);
      if (/^[A-Z]/.test(named)) found.push(`${file}:${p.node.loc?.start.line ?? 0} ${named}`);
    },
  });
  return found;
}

test("no component renders through the global t", () => {
  const all: string[] = [];
  for (const file of new Bun.Glob("web/src/**/*.tsx").scanSync(".")) {
    all.push(...offenders(file, readFileSync(file, "utf8")));
  }
  expect(all).toEqual([]);
});

/** Shown firing, and shown quiet on the two shapes it must not fire on. */
test("it fires on a component and not on a helper or a hook binding", () => {
  const global = 'import { t } from "@lingui/core/macro";\n';
  expect(offenders("p.tsx", `${global}export function Pane() { return <p>{t\`Skills\`}</p>; }`)).toHaveLength(1);
  // A callback inside the component is the component's scope.
  expect(offenders("p.tsx", `${global}export function Pane() { return <b onClick={() => t\`x\`} />; }`)).toHaveLength(
    1,
  );

  expect(offenders("p.tsx", `${global}const note = (n: number) => t\`{n} left\`;`)).toEqual([]);
  expect(
    offenders("p.tsx", "export function Pane() { const { t } = useLingui(); return <p>{t`Skills`}</p>; }"),
  ).toEqual([]);

  // Same rule, one API over.
  expect(offenders("p.tsx", "export function Pane() { return <p>{i18n._(LABEL)}</p>; }")).toHaveLength(1);
  expect(offenders("p.tsx", "const label = (k: string) => i18n._(LABEL[k]);")).toEqual([]);
});
