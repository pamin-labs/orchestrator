import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Gates, ImageRow, Sandbox, type ProjectConfig } from "../../web/src/views/project.tsx";
import { FirstProject } from "../../web/src/views/picker.tsx";
import {
  arrowStep,
  cacheDirsFrom,
  cacheDirsText,
  domainHost,
  domainKey,
  gateRows,
  gateTemplate,
  imageOptions,
  imageSource,
  moveGate,
  sandboxRows,
  sandboxSet,
} from "../../web/src/features/project/model.ts";
import { browseListing, browseRow, days, entryMeta, repoRow } from "../../web/src/features/picker/model.ts";
import {
  badCell,
  durationScale,
  invalidFlag,
  labelledBy,
  mateValue,
  notifyState,
  NO_COMPLAINT,
  rec,
  rowChanged,
  runtimeSwitch,
  selfNamed,
  textOf,
} from "../../web/src/features/knobs/model.ts";

/**
 * The three settings surfaces the boss changes a project through: the gates that
 * decide what "done" means, the box the agents run in, and the two pickers that
 * add a project at all.
 *
 * Every rule below was a closure inside a component that fetches its own data,
 * so the only way to ask whether a cleared override actually clears was to open
 * a browser — and half of these surfaces live behind a Radix portal, which
 * renders nothing at all on a server.
 */

const config = (over: Partial<ProjectConfig> = {}): ProjectConfig => ({
  repoPath: "/w/alpha",
  config: { gates: ["test", "lint"] },
  resources: [
    { name: "lint", template: "bun run lint" },
    { name: "test", template: "bun test" },
    { name: "typecheck", template: "bun run typecheck" },
  ],
  baseBranch: null,
  baseBranchNow: "main",
  branches: ["main", "dev"],
  ...over,
});

// ---------------------------------------------------------------- gates

test("the gates that run are listed in run order, numbered, above the ones that do not", () => {
  const html = renderToStaticMarkup(<Gates d={config()} patch={() => {}} />);
  // The stored order is the run order. Rendering the catalogue's alphabetical
  // order while numbering each row by its position read 2, 1 down the page.
  expect(html.indexOf("bun test")).toBeLessThan(html.indexOf("bun run lint"));
  // Every running gate carries its position and its command, so the header's
  // three columns are three facts rather than one name repeated.
  expect(html).toContain("顺序");
  expect(html).toContain("名字");
  expect(html).toContain("命令");
  // A detected command nobody turned on sits under its own heading, unnumbered.
  expect(html).toContain("关掉的");
  expect(html).toContain("点一下加到最后一道");
  expect(html).toContain("bun run typecheck");
  expect(html).toContain("从上往下跑，拖着改顺序");
});

test("a project with no gates on is told what that costs, and one with no commands is told why", () => {
  const none = renderToStaticMarkup(<Gates d={config({ config: {} })} patch={() => {}} />);
  expect(none).toContain("一道都没开，LLM 审阅底下就没有地板。");
  // Nothing was detected at all: a different sentence, because it is fixed in a
  // different place — there is nothing to switch on.
  const bare = renderToStaticMarkup(<Gates d={config({ config: {}, resources: [] })} patch={() => {}} />);
  expect(bare).toContain("没探到可跑的命令。");
  expect(bare).not.toContain("一道都没开");
  expect(bare).not.toContain("关掉的");
});

test("a stored gate the repository no longer has drops off both lists", () => {
  // The command was renamed or removed. A row for a gate nothing can run is a
  // row that can only ever fail, and it must not keep its slot in the order.
  const rows = gateRows(
    ["test", "gone", "lint"],
    [
      { name: "lint", template: "l" },
      { name: "test", template: "t" },
    ],
  );
  expect(rows.on).toEqual(["test", "lint"]);
  expect(rows.off).toEqual([]);
  expect(gateTemplate([{ name: "test", template: "bun test" }], "test")).toBe("bun test");
  expect(gateTemplate([], "test")).toBe("");
});

test("reordering a gate returns a new order, and a drop that changed nothing returns none", () => {
  expect(moveGate(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
  expect(moveGate(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
  // Null, not the same list: the caller writes whatever it gets back, and a drag
  // that ended where it started would otherwise be a save and a 已保存 for an
  // order identical to the stored one.
  expect(moveGate(["a", "b"], 1, 1)).toBeNull();
  expect(moveGate(["a", "b"], -1, 0)).toBeNull();
  // Pushing the last gate further down is off the end of the list, not a move.
  expect(moveGate(["a", "b"], 1, 2)).toBeNull();
});

test("only Alt plus an up or down arrow moves a gate", () => {
  // The rows are a toggle group, where the bare arrows already move focus. Alt
  // is what leaves the keyboard a way to reorder at all — native drag covers the
  // mouse and covers nothing else.
  expect(arrowStep(true, "ArrowUp")).toBe(-1);
  expect(arrowStep(true, "ArrowDown")).toBe(1);
  expect(arrowStep(false, "ArrowUp")).toBeNull();
  expect(arrowStep(true, "Enter")).toBeNull();
  expect(arrowStep(true, "ArrowLeft")).toBeNull();
});

// -------------------------------------------------------------- sandbox

test("the sandbox pane shows every unset override as an empty box with the default named", () => {
  const html = renderToStaticMarkup(<Sandbox d={config()} busy={false} patch={() => {}} />);
  expect(html).toContain("沙盒");
  expect(html).toContain("灰字是默认值");
  // The inherited value is the placeholder, never the value: a box pre-filled
  // with the default saves that default as this project's own the first time it
  // loses focus, and the project stops following the machine.
  expect(html).toContain("main（远端说的）");
  expect(html).toContain("留空由 bootstrap 读仓库判断");
  expect(html).toContain("宿主核数的 1/4");
  expect(html).toContain("8Gi");
  expect(html).toContain("留空 = 出站不拦（README 那节）");
  expect(html).toContain("/root/.bun/install/cache:/var/tmp/orch-cache");
});

test("stored sandbox overrides reach their controls as values, and blocked domains as chips", () => {
  const d = config({
    baseBranch: "release",
    config: {
      install: "bun install --frozen-lockfile",
      sandbox: { cpu: "6", memory: "16Gi", denyDomains: ["api.openai.com"], cacheDirs: { "/root/.bun": "/var/c" } },
    },
  });
  const html = renderToStaticMarkup(<Sandbox d={d} busy={false} patch={() => {}} />);
  expect(html).toContain("release");
  expect(html).toContain("bun install --frozen-lockfile");
  expect(html).toContain('value="6"');
  expect(html).toContain('value="16Gi"');
  // One chip per domain, each with a way off. A space-separated string cannot
  // say that one entry of it is wrong.
  expect(html).toContain("api.openai.com");
  expect(html).toContain("不再禁止 api.openai.com");
  // The map is one line of mount:host pairs, which is what the box takes back.
  expect(html).toContain("/root/.bun:/var/c");
  // With a domain already listed the box asks for another, not for the first.
  expect(html).toContain("再加一个");
});

test("an override that is cleared leaves the patch rather than being sent as undefined", () => {
  // Serialised to JSON on the way out, an `undefined` value is not a key that
  // was cleared — it is a key that never appears, so the stored override would
  // have survived every attempt to take it off.
  expect(sandboxSet({ cpu: "6", memory: "16Gi" }, "cpu", undefined)).toEqual({ memory: "16Gi" });
  expect(sandboxSet({ cpu: "6" }, "memory", "8Gi")).toEqual({ cpu: "6", memory: "8Gi" });
  expect(Object.keys(sandboxSet({ cpu: "6" }, "cpu", undefined))).toEqual([]);
});

test("every absent sandbox override reaches its box as empty", () => {
  const rows = sandboxRows(null, undefined, null, undefined);
  expect(rows).toMatchObject({
    baseBranch: "",
    branches: [],
    install: "",
    image: "",
    cpu: "",
    memory: "",
    denyDomains: [],
    cacheDirs: "",
  });
  expect(sandboxRows("dev", ["dev"], "bun i", { image: "ghcr.io/x:1" })).toMatchObject({
    baseBranch: "dev",
    branches: ["dev"],
    install: "bun i",
    image: "ghcr.io/x:1",
  });
});

test("shared cache pairs survive a trip through the box, colons in the mount included", () => {
  const dirs = { "/root/.bun/install/cache": "/var/tmp/orch-cache", "/root/.cache": "/var/tmp/c2" };
  expect(cacheDirsFrom(cacheDirsText(dirs))).toEqual(dirs);
  // Split at the last colon: the mount point is a path and may carry one.
  expect(cacheDirsFrom("/a:b:/host")).toEqual({ "/a:b": "/host" });
  // A pair with no host is a mount onto nothing, so it is dropped rather than
  // stored as a rule the sandbox server can never satisfy.
  expect(cacheDirsFrom("/a /b:/host")).toEqual({ "/b": "/host" });
  expect(cacheDirsFrom("   ")).toEqual({});
});

test("whatever is pasted into the domain box is reduced to the host the sidecar matches", () => {
  // Stored verbatim, `https://evil.example.com/x` matched nothing — and an
  // egress rule that silently matches nothing is the worst kind: the pane says
  // the domain is blocked and it is not.
  expect(domainHost("https://Evil.Example.com/x?y#z")).toBe("evil.example.com");
  expect(domainHost("  registry.npmjs.org:443  ")).toBe("registry.npmjs.org");
  expect(domainHost("http://a.b/")).toBe("a.b");
  expect(domainHost("")).toBe("");
});

test("Enter commits a domain and Backspace on an empty box takes the last chip", () => {
  expect(domainKey("Enter", "api.openai.com", 0)).toBe("add");
  expect(domainKey("Backspace", "", 2)).toBe("drop");
  // Only on an empty box: mid-word Backspace has to keep editing the word.
  expect(domainKey("Backspace", "api", 2)).toBeNull();
  // And only when there is a chip to take.
  expect(domainKey("Backspace", "", 0)).toBeNull();
  expect(domainKey("a", "", 2)).toBeNull();
});

// ---------------------------------------------------------------- image

test("the image row offers both sources and says it is still reading them", () => {
  const html = renderToStaticMarkup(<ImageRow value="" busy={false} onSave={() => {}} />);
  expect(html).toContain("镜像");
  expect(html).toContain("远程");
  expect(html).toContain("本地");
  // Before the lists land there is no default to name, and a box promising one
  // is a box that has not asked yet.
  expect(html).toContain("读取中…");
  expect(html).not.toContain("跟这台机器的默认");
});

test("a bare tag is a local build and a registry name is a published one", () => {
  // The sandbox refuses anything that is neither, so which list a value came
  // from is readable off the value itself.
  expect(imageSource("orch-sandbox:dev")).toBe("local");
  expect(imageSource("ghcr.io/pamin-labs/orch:1")).toBe("remote");
  // Nothing chosen yet starts on the answer for everybody not developing this
  // project: the published image needs nothing on this machine.
  expect(imageSource("")).toBe("remote");
});

test("each source shows its own names and its own kind of empty", () => {
  const choices = {
    published: ["ghcr.io/pamin-labs/orch:1"],
    local: [],
    note: { published: "已发布 1 个", local: "本机没 build 过" },
  };
  expect(imageOptions("remote", choices)).toEqual({ options: choices.published, note: "已发布 1 个" });
  // "nothing built here" and "could not reach ghcr.io" are the same empty list
  // and send a reader to different places, so the note is per source.
  expect(imageOptions("local", choices)).toEqual({ options: [], note: "本机没 build 过" });
  expect(imageOptions("remote", null)).toEqual({ options: [], note: undefined });
});

// --------------------------------------------------------------- picker

test("the first-project card names the action and shows rows before any repository lands", () => {
  const html = renderToStaticMarkup(<FirstProject onAdded={() => {}} onSettings={() => {}} />);
  expect(html).toContain("添加第一个项目");
  expect(html).toContain("点一行就添加");
  expect(html).toContain("筛一下，或者直接打名字");
});

test("a directory listing puts directories above files and turns its path into crumbs", () => {
  const listing = {
    path: "/w/alpha",
    dirs: [{ name: "src", path: "/w/alpha/src", repo: false, taken: false }],
    files: [{ name: "notes.md", path: "/w/alpha/notes.md", size: 4096 }],
  };
  const { parts, rows } = browseListing(listing);
  expect(parts).toEqual(["w", "alpha"]);
  // Everything that goes anywhere is at the top: the list is walked, not read.
  expect(rows.map(([entry, isDir]) => [entry.name, isDir])).toEqual([
    ["src", true],
    ["notes.md", false],
  ]);
  // Nothing loaded yet is a crumb trail of nothing and no rows, not a crash.
  expect(browseListing(null)).toEqual({ parts: [], rows: [] });
});

test("a row's right edge shows the one fact that outranks the others", () => {
  const repo = { name: "alpha", path: "/w/alpha", repo: true, taken: true };
  // Already picked beats already added beats being a repository beats size.
  expect(entryMeta(repo, true, false)).toBe("已选");
  expect(entryMeta(repo, false, false)).toBe("已添加");
  expect(entryMeta({ name: "b", path: "/b", repo: true }, false, false)).toBe("git 仓库");
  // Picking attachments, being a git repository is not a fact about the choice.
  expect(entryMeta({ name: "b", path: "/b", repo: true }, false, true)).toBe("");
  expect(entryMeta({ name: "f", path: "/f", size: 4096 }, false, true)).toBe("4k");
  // A file smaller than a kilobyte still reads as one: 0k is not a size.
  expect(entryMeta({ name: "f", path: "/f", size: 12 }, false, true)).toBe("1k");
  expect(entryMeta({ name: "d", path: "/d" }, false, false)).toBe("");
});

test("a repository is marked as one only where the mark means something", () => {
  const repo = { name: "alpha", path: "/w/alpha", repo: true };
  expect(browseRow(repo, true, false, false)).toMatchObject({ glyph: "◆", repo: true, meta: "git 仓库" });
  // Attachment picking: every directory is just a directory to reach into, and
  // an accented ◆ on a third of them says nothing about what is being chosen.
  expect(browseRow(repo, true, true, false)).toMatchObject({ glyph: "▸", repo: false });
  expect(browseRow({ name: "f", path: "/f" }, false, true, false)).toMatchObject({ glyph: "·", repo: false });
});

test("a repository row drops the owner and offers what pressing it would do", () => {
  const now = Date.now();
  const fresh = { fullName: "pamin-labs/alpha", defaultBranch: "main", pushedAt: now, taken: null };
  expect(repoRow(fresh, "")).toEqual({ name: "alpha", meta: "今天", action: "添加 · main", adding: false });
  // A repository that is already a project cannot be added again, so its row
  // goes somewhere instead of doing something.
  const taken = { ...fresh, taken: { id: 7, name: "alpha" } };
  expect(repoRow(taken, "")).toMatchObject({ meta: "已添加", action: "去 alpha →" });
  // While one is being added it says so and stops offering anything.
  expect(repoRow(fresh, "pamin-labs/alpha")).toMatchObject({ meta: "添加中…", adding: true });
  // A name with no owner in it is still a name.
  expect(repoRow({ ...fresh, fullName: "alpha" }, "").name).toBe("alpha");
});

test("a repository's age is read at the resolution anyone acts on", () => {
  const day = 86_400_000;
  expect(days(Date.now() - day * 3)).toBe("3 天前");
  expect(days(Date.now() - day * 60)).toBe("2 个月前");
  expect(days(Date.now())).toBe("今天");
  // Never pushed is not "today"; it is nothing worth printing.
  expect(days(0)).toBe("");
});

// ---------------------------------------------------------------- knobs

test("a refusal marks the cell it is about, and nothing at all when there is none", () => {
  // `""` is the row's own single box and null is "nothing was refused". Collapsed
  // into one, every box on the pane rendered invalid the moment it appeared.
  expect(badCell(NO_COMPLAINT)).toBeNull();
  expect(invalidFlag(NO_COMPLAINT)).toBeUndefined();
  expect(badCell({ why: "要一个整数", at: "browser" })).toBe("browser");
  expect(badCell({ why: "要一个数字", at: "" })).toBe("");
  expect(invalidFlag({ why: "要一个整数", at: "browser" })).toBe("true");
});

test("a row is 已改 when either half of it is", () => {
  const on = { overridden: true };
  const off = { overridden: false };
  expect(rowChanged(off, null)).toBe(false);
  expect(rowChanged(on, null)).toBe(true);
  // One row, so one 已改 — the index runtime and its model are one decision.
  expect(rowChanged(off, on)).toBe(true);
  expect(rowChanged(off, off)).toBe(false);
});

test("rows whose control cannot carry a label name themselves through their title", () => {
  // A `<label for>` and a title cannot both hold the same id, and a switch or a
  // six-box table has nothing for a label to point at.
  expect(selfNamed("difficultyModel", "object")).toBe(true);
  expect(selfNamed("autoAdvance", "boolean")).toBe(true);
  expect(selfNamed("maxGroups", "number")).toBe(false);
  expect(labelledBy("maxGroups", "number", "knob-maxGroups")).toBeUndefined();
  expect(labelledBy("autoAdvance", "boolean", "knob-autoAdvance")).toBe("knob-autoAdvance");
});

test("a stored value becomes the text its box holds, whatever shape it is", () => {
  expect(textOf(null)).toBe("");
  expect(textOf("127.0.0.1:8080")).toBe("127.0.0.1:8080");
  expect(textOf(45)).toBe("45");
  expect(textOf(true)).toBe("true");
  expect(textOf({ a: 1 })).toBe('{"a":1}');
  // A map row hands its editor an object; anything else hands it an empty one
  // rather than letting a scalar be spread into key/value boxes.
  expect(rec({ browser: 1 })).toEqual({ browser: 1 });
  expect(rec([1, 2])).toEqual({});
  expect(rec(null)).toEqual({});
  expect(rec(7)).toEqual({});
  expect(mateValue(null)).toBeNull();
  expect(mateValue({ value: "claude-opus-5" })).toBe("claude-opus-5");
});

test("a duration knob is scaled to milliseconds for the picker and back to its own unit", () => {
  // `turnTimeoutMs` is milliseconds and `sandbox.ttlSeconds` is seconds, and
  // both are typed in 分钟 / 小时 — so the picker works in one scale and this is
  // the only place the other one is named.
  expect(durationScale("ms")).toBe(1);
  expect(durationScale("seconds")).toBe(1000);
  expect(durationScale("count")).toBe(0);
  expect(durationScale("percent")).toBe(0);
  expect(durationScale(undefined)).toBe(0);
});

test("switching the index runtime carries the model only when it has to", () => {
  // `gpt-5.6-luna` on claude is a model that runtime cannot run, on by its own
  // note the most frequent model call in the system.
  expect(runtimeSwitch("claude", "codex", "claude-haiku-4-5", "gpt-5.6-luna")).toEqual({
    runtime: "claude",
    model: "claude-haiku-4-5",
  });
  // Already the right model for the new runtime: nothing to write.
  expect(runtimeSwitch("claude", "codex", "claude-haiku-4-5", "claude-haiku-4-5")).toEqual({
    runtime: "claude",
    model: null,
  });
  // A runtime with nothing in `difficultyModel` leaves the model alone rather
  // than clearing it.
  expect(runtimeSwitch("codex", "claude", undefined, "claude-opus-5")).toEqual({ runtime: "codex", model: null });
  // Pressing the lit segment, or turning the group off, is not a change.
  expect(runtimeSwitch("claude", "claude", "x", "y")).toBeNull();
  expect(runtimeSwitch("", "claude", "x", "y")).toBeNull();
});

test("the notification row separates the three ways there is no permission", () => {
  // A browser without the API and a browser that was told no are both "you will
  // not get one", and only one of them is fixable from this page at all.
  expect(notifyState(false, "default")).toBe("unsupported");
  expect(notifyState(true, "granted")).toBe("granted");
  expect(notifyState(true, "denied")).toBe("denied");
  expect(notifyState(true, "default")).toBe("ask");
});
