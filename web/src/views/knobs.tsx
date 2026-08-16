import { Fragment, useEffect, useState } from "react";
import { RotateCcw, X } from "lucide-react";
import { post, pull } from "../lib/api";
import { cn } from "../lib/utils";
import {
  COUNT_UNITS, DURATION_UNITS, KNOB_SHAPE, WANTS, countOf, msOf, readNumber, showNumber, splitCount,
  splitDuration,
} from "../lib/units";
import { allModels, cheapest, modelsByRuntime, type ModelSources } from "../lib/models";
import { Combobox } from "../ui/combobox";
import { Field, FieldContent, FieldGroup, FieldLabel, FieldTitle } from "../ui/field";
import { Head, Input, Meta, Textarea } from "../ui/bits";
import { Button } from "../ui/button";
import { Segment, Segments, Toggles } from "../ui/segment";
import { Switch } from "../ui/switch";
import { Help, Tip } from "../ui/tooltip";

/**
 * The operating knobs, as rows.
 *
 * These used to live in `config/default.yaml` with a hundred lines of comments
 * around them, and those comments are the most expensive thing in that file —
 * every number is a measurement someone paid for. They come across as the `?` on
 * each row. A settings page that lists forty numbers with no reasons is a page
 * that gets a number changed once and never changed back.
 *
 * The server sends value, default and whether it was overridden; the labels and
 * the reasons live here, because they are copy.
 *
 * Three things this page owes the reader, and did not:
 *
 * - **A value in the unit it means.** `1200000` is twenty minutes and
 *   `10800000` is three hours, and told apart by counting zeros. `lib/units.ts`
 *   does the conversion and `test/knob-units.test.ts` holds it to being exact.
 * - **A shape for the value it holds.** Six of these are tables — runtime by
 *   difficulty, model by window, mount by host path — and a table crammed into
 *   one line of JSON is a value nobody can read and nobody can fix by hand.
 * - **A refusal where the value is.** A toast in the corner outlives the fix and
 *   never says which of the four boxes on the row it meant.
 *
 * No save button anywhere: a field is written when it loses focus, and the band
 * at the top says when the last write landed.
 */

interface Knob {
  path: string;
  type: string;
  value: unknown;
  default: unknown;
  overridden: boolean;
}

export type KnobSection = "sched" | "models" | "turn" | "boxdefaults" | "notify";

/** The three difficulty labels the dispatcher hands out. Three knobs are keyed by them. */
const TIERS = ["trivial", "normal", "hard"] as const;

/** One track per tier, shared by the two blocks keyed by them so they line up. */
const TIER_GRID = "grid w-full grid-cols-[3.25rem_repeat(3,minmax(0,1fr))]";

/** Which rows a section shows, in the order they are shown. */
const SECTIONS: Record<KnobSection, { zh: string; note: string; paths: string[] }> = {
  sched: {
    zh: "调度",
    note: "同时开工多少、谁等谁",
    paths: ["maxGroups", "leaseSlots", "watchdogIntervalMs", "autoAdvance", "autoAcceptTiers", "parkAfterPausedMs"],
  },
  models: {
    zh: "模型与预算",
    note: "花钱的那几个旋钮",
    paths: ["difficultyModel", "indexModel.runtime", "contextWindow", "sliceBudgetTokens", "language"],
  },
  turn: {
    zh: "turn 与上下文",
    note: "一轮能跑多久、能读多少",
    paths: [
      "turnTimeoutMs", "maxTurnsPerJob", "sessionRotateFraction", "ctxBudgetChars",
      "unreadDigestThreshold", "feedbackSedimentThreshold", "gateRetries",
      "leaseTimeoutMs", "installTimeoutMs", "skillsDir",
    ],
  },
  notify: {
    zh: "通知",
    note: "有事叫你的方式",
    paths: ["notifyWebhook"],
  },
  boxdefaults: {
    zh: "沙盒默认值",
    note: "没自己设的项目用这些",
    paths: ["sandbox.server", "sandbox.image", "sandbox.cpu", "sandbox.memory", "sandbox.ttlSeconds", "sandbox.denyDomains", "sandbox.cacheDirs"],
  },
};

/**
 * Label, the reason the default is what it is, and what an empty box would mean.
 *
 * The reasons are verbatim from the yaml this replaced. The labels are short on
 * purpose: they share one column with every other row on the page, and a label
 * that wraps to three lines pushes its own value out of line with the value
 * above it, which is the whole reason the values are in a column.
 */
const COPY: Record<string, { zh: string; why?: string; ph?: string }> = {
  maxGroups: {
    zh: "同时开工的需求数",
    why: "先撞上的天花板通常不是这个数：两个组不能拥有重叠路径，所以可分的模块少的项目达不到 10；再就是账号自己的限流。调高了记得看成本页的 cache 命中率——同一个订阅上并发多，节流最先在那里现形。",
  },
  leaseSlots: {
    zh: "闸门并发",
    why: "一个 lease 是一次真的编译或测试。十个同时跑会把机器拖垮，而且卡死的 lease 会占着槽位到超时。browser 单独给 1，因为每个都是一个真的 Chromium——不分池的话所有闸门都得排在一次截图后面。",
  },
  watchdogIntervalMs: {
    zh: "看门狗周期",
    why: "确定性规则多久跑一遍。也是没有显式 tick 的入队要等多久才被派发。",
  },
  autoAdvance: {
    zh: "批了就往下做",
    why: "关掉的话一个组做完一片就停到早上，等于放弃了这套系统存在的理由。代价说清楚：某一片方向错了，后面几片是在它基础上做的——你退回那一片时全组会停下并说明，而不是悄悄在已完成的工作底下改地基。",
  },
  autoAcceptTiers: {
    zh: "自动查收",
    why: "四道闸（自评 / 对账 / 跑测试 / QA）全过之后，省掉的是第五层「你亲自看一眼」。默认 trivial 和 normal，hard 仍然等你——那一眼在最便宜的两档上最不值钱。",
  },
  parkAfterPausedMs: {
    zh: "暂停多久后封存",
    why: "封存会退掉沙盒。挂起太久的组占着并发名额而没人在推它。",
  },
  difficultyModel: {
    zh: "难度 → 模型",
    why: "Dispatcher 给每片打难度标签，这张表把标签换成模型。哪个角色用哪个 CLI 写在 roles/*.yaml，这里只管「那个 CLI 上，这个难度用哪个模型」。改了只影响之后新雇的 agent——模型在雇的时候就冻进 agent 行了。",
  },
  "indexModel.runtime": {
    zh: "索引模型",
    why: "全系统调用最频繁的一个模型调用：纯摘要、不做决策、不用工具、不碰黑板。第一个该从贵订阅上挪走的就是它。",
  },
  contextWindow: {
    zh: "上下文窗口",
    why: "轮换 session 的分母。两个 CLI 在 turn 里都会报真实值，那个值优先；这张表管的是一个 session 的第一个 turn。写死成 200k 的那阵子，强模型一直在 1M 窗口的 12% 处轮换，每轮换一次就扔掉一次花钱建起来的缓存前缀。",
  },
  sliceBudgetTokens: {
    zh: "每片 token 上限",
    why: "取自本仓库 16 个真实切片：trivial 均值 4.0M（有一个 12.0M 跑飞的），normal 均值 7.3M 尾部 16.1M。卡在「跑完的最坏一片」之上、「跑飞那一片」之下——这个上限是给已经迷路的 agent 用的，不是给今天状态不好的那个。改了只影响新切片。",
  },
  language: {
    zh: "对外语言",
    why:
      "管 journal / 频道消息 / 问你的问题 / 状态摘要。这些都是 agent 写的，所以写什么语言都行——列表只是省打字，不是能选的全部。" +
      "代码、commit message、分支名、PR、错误信息永远是英文。" +
      "orchestrator 自己那二十几条状态文案只有中文和英文两套，别的语言它们会退回英文——agent 写的东西不受影响。" +
      "改这一项会让全舰队轮换一次 session——它在缓存前缀里。",
  },
  turnTimeoutMs: {
    zh: "单轮墙钟上限",
    why: "超过就由看门狗打断。实测最长的一次单轮是 8.2 分钟。",
  },
  maxTurnsPerJob: {
    zh: "单轮最多几步",
    why: "实测 259 个真实 turn：中位数 36 步，p90 是 93，最大 144——而超过 60 步的那 23% 吃掉了整个 cache-read 账单的 59%，因为每一步都要重读整条 transcript。36 是活儿，尾巴是一个已经迷路、正在 grep 的 agent。砍尾巴不动中位数。改这一项会让全舰队轮换一次 session。",
  },
  sessionRotateFraction: {
    zh: "换会话的水位",
    why: "上下文用到窗口的这么多就换一个会话。兜底触发器，真正的轮换点是切片做完——那是个干净的语义边界，交接也便宜。",
  },
  ctxBudgetChars: {
    zh: "ctx 答案上限",
    why: "约等于 4k token。这个答案会落进 transcript，而 transcript 这个会话剩下的每一轮都要重读一遍——所以慷慨的答案在问题被回答完很久之后还在收费。",
  },
  unreadDigestThreshold: { zh: "未读摘要条数", why: "一轮最多把多少条频道消息塞进 delta。" },
  feedbackSedimentThreshold: { zh: "几次抱怨变规则", why: "同一件事说到第 N 次，它就该是项目的一条规则，而不是第 N+1 次抱怨。" },
  gateRetries: { zh: "闸门重试次数", why: "同一片连着几次没过就升级给人，而不是一直重试同一条路。" },
  leaseTimeoutMs: {
    zh: "单条闸门上限",
    why: "大项目的一次编译是小时级；完全没有上限的话，一个挂死的 build 会永远占着 lease 槽位，而槽位是全局的、少的——一条卡死的命令能让整个舰队再也过不了闸门。",
  },
  installTimeoutMs: {
    zh: "装依赖上限",
    why: "和 lease 同一个量级，因为是同一类东西——真的在编译。卡太紧的失败长得像「这个项目坏了」而不像「超时了」，而组在两种情况下都一样卡住。",
  },
  "sandbox.server": {
    zh: "沙盒服务器",
    ph: "127.0.0.1:8080",
    why: "opensandbox-server 在哪。必须是 dns+nft 模式，否则凭据注入静默失效。它不一定在这台机器上——Tailscale 上的一台或者一台云机器都行，SDK 只跟它说 HTTP。",
  },
  "sandbox.image": {
    zh: "默认镜像",
    why: "只认两个来源：我们发布的 ghcr.io/pamin-labs/…，和没有 registry 前缀的本机 build。这里面跑的是 agent，而 agent 手里有你的代码——换一个来路不明的镜像就是把整条边界交给别人，而且从面板上看不出任何异常。",
  },
  "sandbox.cpu": {
    zh: "CPU",
    ph: "留空 = 宿主核数的 1/4",
    why: "留空 = 宿主核数的 1/4。SDK 自己的默认值是 \"1\"，这个仓库的 tsc --noEmit 因此要 7.6 秒（6 核是 3.2 秒）。",
  },
  "sandbox.memory": { zh: "内存", ph: "8Gi", why: "每个沙盒的内存上限。" },
  "sandbox.ttlSeconds": {
    zh: "沙盒存活时间",
    why: "turn 开始时会续期，所以这是「没人管了多久回收」，不是任务时长上限。",
  },
  "sandbox.denyDomains": {
    zh: "禁止访问的域名",
    ph: "一行一个域名，留空就都放行",
    why: "黑名单而不是白名单——白名单才是穷举不完的那个（每个 registry、每个文档站）。凭据安全不靠它：真 token 在 sidecar 里，沙盒里是格式合法的假值。",
  },
  "sandbox.cacheDirs": {
    zh: "共享缓存目录",
    ph: "/root/.bun/install/cache",
    why: "所有沙盒共享的宿主目录，「容器里的挂载点: 宿主路径」。只放包管理器缓存。实测这个仓库第二个组的 bun install：不共享 2.9 秒，共享 1.2 秒——小是因为仓库小，到 monorepo 上是分钟级差别。默认关，因为这个仓库最惨的一次事故就是所有 worktree 共用一份 node_modules，两个闸门同时装，组把 EEXIST 当成自己的 build 坏了。另外沙盒服务端的 allowed_host_paths 也得列上这个路径。",
  },
  notifyWebhook: {
    zh: "转发到 webhook",
    ph: "留空就只有这个页面会叫你",
    why: "留空就只有这个页面会叫你。填了的话每条通知会 POST 一份 JSON（title / message / url）过去——ntfy、Bark、群机器人、你今天下午写的东西，都行。出站前会过一遍脱敏，因为这是唯一一个把内容送出这台机器的通道。",
  },
  skillsDir: {
    zh: "技能暂存目录",
    why: "勾中的技能复制到这里，每个沙盒只读挂上去。改这里要同步改沙盒服务端的 allowed_host_paths，否则开容器直接失败——而那是响的失败，比一个静默的空目录好得多。",
  },
};

/** Rows whose value is a table rather than a line: the block sits under nothing. */
const TABLES = new Set([
  "difficultyModel", "sliceBudgetTokens", "contextWindow", "leaseSlots",
  "sandbox.cacheDirs", "sandbox.denyDomains",
]);

/** Rows with no single control for a `<label>` to point at. They name themselves. */
const SELF_NAMED = new Set([...TABLES, "autoAcceptTiers", "indexModel.runtime"]);

/**
 * Two settings the page shows as one row, because they are one decision.
 *
 * `indexModel` is `{runtime, model}` and the settings table splits any object
 * with fixed keys into a path each — so the server offers `indexModel.runtime`
 * and `indexModel.model` and never `indexModel`, which is why the old page,
 * asking for `indexModel`, drew nothing at all: the most-called model in the
 * system had no row and the paragraph explaining why it matters was on screen
 * zero times. Shown together because a model belongs to a CLI; two rows would
 * invite codex plus an Anthropic model, which is a config that boots and then
 * fails on every index call.
 */
const PAIRED: Record<string, string> = { "indexModel.runtime": "indexModel.model" };

type Write = (path: string, value: unknown) => Promise<{ ok: boolean; text: string }>;

export function Knobs({ section }: { section: KnobSection }) {
  const [knobs, setKnobs] = useState<Knob[] | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const load = async () => {
    const d = await pull<{ settings: Knob[] }>("/api/settings");
    if (d) setKnobs(d.settings);
  };
  useEffect(() => {
    void load();
  }, []);

  const write: Write = async (path, value) => {
    // Destructured: `post` returns `{ok, text}`, so `if (!ok)` on the object
    // itself is always false and a refused write would still have said 已保存.
    // `quiet` because the row shows the reason where the value is.
    const r = await post("/api/settings", { path, value }, true);
    if (r.ok) {
      setSaved(new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }));
      await load();
    }
    return r;
  };

  const spec = SECTIONS[section];
  // Built from every knob, not from this section's rows: the model pickers on
  // 模型与预算 read three different paths, and a section that shows one of them
  // still needs the other two to know what to offer.
  const at = (path: string) => (knobs ?? []).find((k) => k.path === path)?.value;
  const src: ModelSources = {
    difficultyModel: at("difficultyModel") as ModelSources["difficultyModel"],
    contextWindow: at("contextWindow") as ModelSources["contextWindow"],
    indexModel: { runtime: at("indexModel.runtime") as string, model: at("indexModel.model") as string },
  };
  const rows = (knobs ?? []).filter((k) => spec.paths.includes(k.path));
  rows.sort((a, b) => spec.paths.indexOf(a.path) - spec.paths.indexOf(b.path));

  return (
    // The dialog sets one label column for every pane in it (5rem, which holds
    // 基线分支 and API 密钥). These labels are sentences rather than nouns —
    // 暂停多久后封存, 几次抱怨变规则 — so the five knob panes share a wider one
    // among themselves rather than each row wrapping to three lines.
    <div className="[--label:8.5rem]">
      {/* Where a save button would be. There is none: a field is written when it
          loses focus, and this says the write landed. */}
      <Head title={spec.zh} note={spec.note}>
        {/* Clear of the dialog's close button, which is absolutely positioned
            over this band and was sitting on the last character of the time. */}
        {saved && <Meta className="mr-7">已保存 {saved}</Meta>}
      </Head>
      {knobs === null ? (
        <Meta className="block py-2">读取中…</Meta>
      ) : (
        // The permission is a row of this list, not a block above it: two
        // `FieldGroup`s stacked leave exactly one missing hairline where they
        // meet, which reads as a list that lost a row.
        <FieldGroup>
          {section === "notify" && <Permission />}
          {rows.map((k) => (
            <Row
              key={k.path}
              knob={k}
              mate={knobs.find((x) => x.path === PAIRED[k.path])}
              src={src}
              onWrite={write}
            />
          ))}
        </FieldGroup>
      )}
    </div>
  );
}

/** Label and reason for a knob, falling back to the raw path. */
const copyFor = (k: Knob) => COPY[k.path] ?? { zh: k.path, why: undefined, ph: undefined };

function Row({ knob, mate, src, onWrite }: { knob: Knob; mate?: Knob; src: ModelSources; onWrite: Write }) {
  // What is wrong, and which box it is wrong in. A table row can hold six boxes
  // and "要一个数量" under all of them says nothing about which.
  const [bad, setBad] = useState<{ why: string; at: string } | null>(null);
  const copy = copyFor(knob);
  const id = `knob-${knob.path.replace(/\W/g, "-")}`;
  const block = TABLES.has(knob.path);

  const put = async (target: Knob, value: unknown) => {
    // Typing the shipped value back is not an override. Otherwise the row reads
    // 已改 while being identical to the default, and the button that clears it
    // appears to do nothing.
    const same = JSON.stringify(value) === JSON.stringify(target.default);
    const r = await onWrite(target.path, same ? null : value);
    // The server's own words. It answers 422 with a plain-text reason, and the
    // reason is more specific than anything this file could guess.
    setBad(r.ok ? null : { why: r.text, at: "" });
  };
  const write = (value: unknown) => void put(knob, value);
  const refuse = (why: string, at = "") => setBad({ why, at });
  const clear = () => setBad(null);
  // One row, so one 已改 — a paired row is changed if either half is.
  const changed = knob.overridden || !!mate?.overridden;

  const value = (
    <Value
      id={id}
      knob={knob}
      mate={mate}
      src={src}
      bad={bad?.at ?? null}
      onWrite={write}
      onWriteMate={mate ? (v) => void put(mate, v) : undefined}
      onRefuse={refuse}
      onClear={clear}
    />
  );

  return (
    <Field data-invalid={bad ? "true" : undefined} {...(SELF_NAMED.has(knob.path) || knob.type === "boolean" ? { "aria-labelledby": id } : {})}>
      {/* The `?` is a sibling of the label, not a child of it: inside a
          `<label htmlFor>` every click on it would also focus the field it
          explains, which is a control that moves the cursor somewhere else. */}
      <div className="flex min-w-0 items-baseline gap-1.5">
        {SELF_NAMED.has(knob.path) || knob.type === "boolean" ? (
          <FieldTitle id={id}>{copy.zh}</FieldTitle>
        ) : (
          <FieldLabel htmlFor={id}>{copy.zh}</FieldLabel>
        )}
        {copy.why && <Help>{copy.why}</Help>}
      </div>
      <FieldContent className="flex-col items-stretch gap-1">
        <div className={cn("flex w-full gap-2", block ? "items-start" : "items-center")}>
          {value}
          {/* Neutral, not the accent: the accent means "waiting on you" and this
              is only "not the shipped value". */}
          {changed && (
            <Tip label="恢复默认">
              <Button
                variant="quiet"
                size="sm"
                aria-label="恢复默认"
                className="shrink-0"
                onClick={() => {
                  write(knob.default);
                  if (mate) void put(mate, mate.default);
                }}
              >
                <RotateCcw className="size-3" />
                已改
              </Button>
            </Tip>
          )}
        </div>
        {bad && <span className="text-[0.6875rem] leading-snug text-accent">{bad.why}</span>}
      </FieldContent>
    </Field>
  );
}

interface Editor {
  id: string;
  knob: Knob;
  /** The second half of a `PAIRED` row, when there is one. */
  mate?: Knob;
  /** Every model this config names, so a picker can offer them. */
  src: ModelSources;
  /** Which cell in this row holds the bad value, `""` for the row itself. */
  bad: string | null;
  onWrite: (value: unknown) => void;
  onWriteMate?: (value: unknown) => void;
  onRefuse: (why: string, at?: string) => void;
  /** Nothing changed, so nothing this row said about the last attempt still holds. */
  onClear: () => void;
}

function Value({ id, knob, mate, src, bad, onWrite, onWriteMate, onRefuse, onClear }: Editor) {
  const v = knob.value;
  const ph = copyFor(knob).ph;

  // Six of these are tables. Each is drawn as the table it is, which is also the
  // only way to keep the keys valid: a JSON line cannot stop you writing
  // `{"trivial": "8M"}` and a labelled box for a token count can.
  switch (knob.path) {
    case "difficultyModel":
      return <ModelTable table={(v ?? {}) as Record<string, Record<string, string>>} src={src} onWrite={onWrite} />;
    case "sliceBudgetTokens":
      return <Caps caps={(v ?? {}) as Record<string, number>} onWrite={onWrite} />;
    case "indexModel.runtime":
      return (
        <IndexModel
          runtime={String(v ?? "")}
          model={String(mate?.value ?? "")}
          src={src}
          onRuntime={onWrite}
          onModel={onWriteMate ?? onWrite}
        />
      );
    case "language":
      // Any language, suggested rather than restricted. What this governs is
      // what the *agents* write — journals, channel messages, the questions they
      // ask — and a model writes whatever it is told to. `say()`'s two-column
      // table is only the orchestrator's own two dozen status lines, and it
      // falls back to English for anything it does not have; that is a smaller
      // fact than this field, and it is in the row's note.
      return (
        <Combobox free value={String(v ?? "")} options={LANGUAGES} placeholder="中文 / English / 日本語 …" onCommit={onWrite} />
      );
    case "autoAcceptTiers":
      return (
        <Toggles
          value={(v ?? []) as string[]}
          // Sorted back into tier order before it is written: a toggle group
          // hands back the order things were pressed in, and ["normal",
          // "trivial"] is the shipped default with its elements swapped — which
          // this page would then have to call 已改.
          onValueChange={(picked) => onWrite(TIERS.filter((t) => picked.includes(t)))}
          className="flex items-center gap-0.5"
        >
          {TIERS.map((t) => (
            <Segment key={t} value={t}>{t}</Segment>
          ))}
        </Toggles>
      );
    case "contextWindow":
      return <Windows map={rec(v) as Record<string, number>} src={src} onWrite={onWrite} />;
    case "leaseSlots":
      return <Pairs map={rec(v)} kind="int" keyPh="闸门名" bad={bad} onWrite={onWrite} onRefuse={onRefuse} onClear={onClear} />;
    case "sandbox.cacheDirs":
      return <Pairs map={rec(v)} kind="text" keyPh={ph ?? "挂载点"} bad={bad} onWrite={onWrite} onRefuse={onRefuse} onClear={onClear} />;
    case "sandbox.denyDomains":
      return <Lines list={(v ?? []) as string[]} ph={ph} onWrite={onWrite} />;
  }

  if (knob.type === "boolean") {
    // Named by the row's own title rather than by an id of its own — a `<label
    // htmlFor>` and a `FieldTitle` cannot both hold the same id, and the switch
    // is the thing that needs the name.
    return <Switch aria-labelledby={id} checked={Boolean(v)} onCheckedChange={onWrite} />;
  }

  if (knob.type === "number") {
    const shape = KNOB_SHAPE[knob.path];
    const now = Number(v);
    // A duration or a count is a number and a unit, so it gets two controls. The
    // text parser below still handles the rest — and still accepts `3h` typed
    // into the digits box's sibling — but nobody has to spell anything.
    if (shape === "ms" || shape === "seconds") {
      const ms = shape === "seconds" ? now * 1000 : now;
      const { n, unit } = splitDuration(ms);
      return (
        <Amount
          n={n}
          unit={unit}
          units={DURATION_UNITS}
          label={copyFor(knob).zh}
          invalid={bad === ""}
          onCommit={(next, u) => onWrite(shape === "seconds" ? Math.round(msOf(next, u) / 1000) : msOf(next, u))}
        />
      );
    }
    if (shape === "count") {
      return <CountAmount value={now} label={copyFor(knob).zh} invalid={bad === ""} onWrite={onWrite} />;
    }
    // Stored as a fraction of one and read as a percentage, which is the row
    // where a typo is quietest: `6` typed over `60%` is a legal fraction and
    // means every turn rotates its session. Digits plus a fixed suffix leaves no
    // way to type the number in the other scale by accident.
    if (shape === "percent") {
      return (
        <Amount
          n={Math.round(now * 1000) / 10}
          unit="%"
          units={PERCENT}
          label={copyFor(knob).zh}
          invalid={bad === ""}
          onCommit={(pct) => {
            if (pct <= 0 || pct > 100) return onRefuse(WANTS.percent);
            // Divided, not multiplied: 600 / 1000 is the same double as 0.6.
            onWrite(Math.round(pct * 10) / 1000);
          }}
        />
      );
    }
    return (
      <Box
        id={id}
        value={showNumber(now, shape)}
        invalid={bad === ""}
        className="w-[9rem] flex-none"
        onUnchanged={onClear}
        onCommit={(raw) => {
          const n = readNumber(raw, now, shape);
          if (n === null) return onRefuse(shape ? WANTS[shape] : "要一个数字");
          onWrite(n);
        }}
      />
    );
  }

  return (
    <Box id={id} value={String(v ?? "")} placeholder={ph} invalid={bad === ""} onUnchanged={onClear} onCommit={onWrite} />
  );
}

const rec = (v: unknown) => (v ?? {}) as Record<string, unknown>;

const PERCENT = ["%"] as const;

/** The window every model without a row of its own falls back to. Not a model. */
const DEFAULT_KEY = "default";

/**
 * Suggestions, not a set. `output.language` is an instruction to a model, and a
 * model writes whatever it is told to — the list is here to save typing and to
 * say what the field wants, not to have an opinion about which languages exist.
 */
const LANGUAGES = ["中文", "English", "日本語", "한국어", "Español", "Français", "Deutsch", "Português", "Русский"];

/**
 * One box, written when it loses focus.
 *
 * Uncontrolled and keyed on the stored value: a refused edit keeps the text that
 * was typed (so it can be fixed rather than retyped) and an accepted one snaps
 * to what the server actually holds, which is how `20 分钟` appears after
 * someone types `1200s`.
 */
/**
 * A number and its unit, as two controls instead of one string to spell.
 *
 * The parser stays — `20 分钟`, `3h`, `8M` all still work if someone types them
 * — but nobody has to. The reason is what the boss can get wrong: one box
 * holding `1200000` invites a zero too many, and one box holding `20 分钟`
 * invites `20 分` (fine), `20m` (fine), `20 min钟` (refused, and the refusal is
 * about spelling rather than about the number). Splitting them means the only
 * free text left is digits, and the input refuses everything but digits.
 *
 * Integer-only, which is why `splitCount` exists next to `fmtCount`: the reading
 * format prints 8500000 as `8.5M`, and 8.5 is not something a spinner can step
 * or an integer field can hold. The picker shows 8500k instead.
 */
function Amount<U extends string>({
  n, unit, units, invalid, label, onCommit,
}: {
  n: number;
  unit: U;
  units: readonly U[];
  invalid?: boolean;
  label: string;
  onCommit: (n: number, unit: U) => void;
}) {
  // Held locally so that changing the unit keeps the digits already typed, and
  // so a value the server snapped to a different unit re-splits on the way back.
  const [draft, setDraft] = useState(String(n));
  useEffect(() => setDraft(String(n)), [n, unit]);

  const send = (raw: string, u: U) => {
    const v = Number(raw);
    if (raw !== "" && Number.isInteger(v) && v >= 0) onCommit(v, u);
    else setDraft(String(n));
  };

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <Input
        type="number"
        inputMode="numeric"
        min={0}
        step={1}
        value={draft}
        aria-label={label}
        aria-invalid={invalid || undefined}
        // Shrinks rather than holding 6.5rem: three of these share the tier grid
        // with a label column, and a fixed width pushed the unit toggle off the
        // right edge of the dialog.
        className="min-w-0 max-w-[6.5rem] flex-1 py-0.5 font-mono text-[0.75rem] aria-[invalid=true]:border-accent"
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={(e) => send(e.currentTarget.value, unit)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          else if (e.key === "Escape") {
            setDraft(String(n));
            e.currentTarget.blur();
          }
        }}
      />
      {/* One unit is not a choice, it is a suffix. */}
      {units.length === 1 ? (
        <Meta>{units[0]}</Meta>
      ) : (
        <Segments value={unit} onValueChange={(u) => u && send(draft, u as U)} aria-label={`${label} 的单位`} className="shrink-0">
          {units.map((u) => (
            <Segment key={u} value={u}>{u || "个"}</Segment>
          ))}
        </Segments>
      )}
    </div>
  );
}

/** A count knob as digits plus k/M. */
function CountAmount({
  value, label, invalid, onWrite,
}: {
  value: number;
  label: string;
  invalid?: boolean;
  onWrite: (n: number) => void;
}) {
  const { n, unit } = splitCount(value);
  return (
    <Amount
      n={n}
      unit={unit}
      units={COUNT_UNITS}
      label={label}
      invalid={invalid}
      onCommit={(next, u) => onWrite(countOf(next, u))}
    />
  );
}

/**
 * Every model this config names, for whichever runtime is being picked.
 *
 * Free text on purpose: see `Combobox`'s `free`. The list spares the typing for
 * the models already in play and does not pretend to know what an account has —
 * neither CLI will tell us.
 */
function ModelPick({
  value, options, disabled, onCommit,
}: {
  value: string;
  options: string[];
  disabled?: boolean;
  onCommit: (v: string) => void;
}) {
  return (
    <Combobox
      free
      disabled={disabled}
      value={value}
      options={options}
      placeholder="模型 id"
      empty="还没有别的模型，直接写就行"
      onCommit={onCommit}
    />
  );
}

function Box({
  value, onCommit, onUnchanged, invalid, className, ...rest
}: {
  value: string;
  onCommit: (raw: string) => void;
  /**
   * Left as it was found — which is a state worth hearing about, because it is
   * how a complaint goes stale: refuse `nope`, press Escape, and the box holds
   * the stored value again while the row still says what was wrong with a string
   * that is no longer in it.
   */
  onUnchanged?: () => void;
  invalid?: boolean;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "defaultValue" | "onChange">) {
  return (
    <Input
      key={value}
      defaultValue={value}
      spellCheck={false}
      aria-invalid={invalid || undefined}
      {...rest}
      className={cn(
        "min-w-0 flex-1 py-0.5 font-mono text-[0.75rem]",
        "aria-[invalid=true]:border-accent",
        className,
      )}
      onBlur={(e) => {
        const raw = e.currentTarget.value.trim();
        if (raw !== value) onCommit(raw);
        else onUnchanged?.();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        else if (e.key === "Escape") {
          e.currentTarget.value = value;
          e.currentTarget.blur();
        }
      }}
    />
  );
}

/**
 * A map the boss fills in: model id to window, mount point to host path.
 *
 * Its keys are not ours to enumerate — a model we have not shipped is exactly
 * what this is for — so it is rows plus one empty row, not a form. Naming the
 * empty row is what adds an entry; there is no ＋ button, because a button that
 * makes a blank row and a blank row are the same thing one click apart.
 */
function Pairs({
  map, kind, keyPh, bad, onWrite, onRefuse, onClear,
}: {
  map: Record<string, unknown>;
  kind: "int" | "text";
  keyPh: string;
  bad: string | null;
  onWrite: (v: unknown) => void;
  onRefuse: (why: string, at?: string) => void;
  onClear: () => void;
}) {
  const entries = Object.entries(map);
  const show = (v: unknown) => String(v ?? "");
  // A number gets the same 9rem a number gets on every other row of this page;
  // only a path needs the rest of the width.
  const vw = kind === "text" ? "" : "w-[9rem] flex-none";
  const commit = (k: string, raw: string) => {
    if (kind === "text") return onWrite({ ...map, [k]: raw });
    if (!/^\d+$/.test(raw)) return onRefuse("要一个整数", k);
    const n = Number(raw);
    onWrite({ ...map, [k]: n });
  };

  return (
    <div className="flex w-full flex-col gap-1">
      {entries.map(([k, v]) => (
        <div key={k} className="flex items-center gap-1.5">
          <Box
            value={k}
            aria-label={`${k} 的名字`}
            className="w-[13rem] flex-none"
            onCommit={(next) => {
              const name = next.trim();
              if (!name) return onRefuse("名字不能空着，要删就按右边的 ×", k);
              // Rebuilt in place rather than deleted and re-added, so a rename
              // does not send the row to the bottom of the list mid-edit.
              onWrite(Object.fromEntries(entries.map(([ek, ev]) => [ek === k ? name : ek, ev])));
            }}
          />
          <Box
            value={show(v)}
            invalid={bad === k}
            aria-label={k}
            className={vw}
            onUnchanged={onClear}
            onCommit={(raw) => commit(k, raw)}
          />
          <Tip label="删掉这一行">
            <Button
              variant="quiet"
              size="sm"
              aria-label={`删掉 ${k}`}
              className="shrink-0"
              onClick={() => onWrite(Object.fromEntries(entries.filter(([ek]) => ek !== k)))}
            >
              <X className="size-3" />
            </Button>
          </Tip>
        </div>
      ))}
      <div className="flex items-center gap-1.5">
        <Box
          // Remounted once a row lands, so the box that added it comes back empty.
          key={`add-${entries.length}`}
          value=""
          placeholder={keyPh}
          aria-label="加一项"
          className="w-[13rem] flex-none"
          onCommit={(k) => {
            const name = k.trim();
            if (name) onWrite({ ...map, [name]: kind === "text" ? "" : 0 });
          }}
        />
        <Meta>填个名字就多一行</Meta>
      </div>
    </div>
  );
}

/** A list of one-per-line strings. Nothing here is ordered, so nothing sorts it. */
function Lines({ list, ph, onWrite }: { list: string[]; ph?: string; onWrite: (v: unknown) => void }) {
  const text = list.join("\n");
  return (
    <Textarea
      key={text}
      defaultValue={text}
      placeholder={ph}
      rows={Math.min(6, Math.max(2, list.length + 1))}
      spellCheck={false}
      onBlur={(e) => {
        const next = e.currentTarget.value.split("\n").map((s) => s.trim()).filter(Boolean);
        if (JSON.stringify(next) !== JSON.stringify(list)) onWrite(next);
      }}
    />
  );
}

/**
 * Runtime by difficulty, drawn as the grid it is.
 *
 * The rows are whichever runtimes the config holds rather than a fixed pair:
 * which CLIs exist is a code decision, and a table that could only ever say
 * claude and codex would be wrong the day a third one lands.
 */
function ModelTable({
  table, src, onWrite,
}: {
  table: Record<string, Record<string, string>>;
  src: ModelSources;
  onWrite: (v: unknown) => void;
}) {
  const byRuntime = modelsByRuntime(src);
  return (
    <div className={cn(TIER_GRID, "items-center gap-x-2 gap-y-1")}>
      <span />
      {TIERS.map((t) => (
        <Meta key={t}>{t}</Meta>
      ))}
      {Object.entries(table).map(([runtime, row]) => (
        <Fragment key={runtime}>
          <Meta className="truncate">{runtime}</Meta>
          {TIERS.map((t) => (
            // Offered that runtime's models only. Pasting a gpt id into the
            // claude row is a model that runtime cannot run, and the turn that
            // finds out is the one that fails.
            <ModelPick
              key={t}
              value={row?.[t] ?? ""}
              options={byRuntime[runtime] ?? []}
              onCommit={(m) => onWrite({ ...table, [runtime]: { ...row, [t]: m } })}
            />
          ))}
        </Fragment>
      ))}
    </div>
  );
}

/**
 * Model to context window: a picker for the key, digits and a unit for the value.
 *
 * Not `Pairs`, which is right for `cacheDirs` and `leaseSlots` because their keys
 * really are free text. A model id is not: it has to match what a role is
 * actually run with, character for character, and the failure of a typo here is
 * silent — the model falls back to the `default` window and rotates its session
 * at a fraction of its real size, which is the exact bug the row's own `?` note
 * describes. Models already named elsewhere in the config are offered; anything
 * else can still be typed, because that is how a new one gets added at all.
 */
function Windows({
  map, src, onWrite,
}: {
  map: Record<string, number>;
  src: ModelSources;
  onWrite: (v: unknown) => void;
}) {
  // `default` first and always present. It is not a model — it is the window
  // every model without a row of its own falls back to — and deleting it drops
  // all of them to `MIN_CONTEXT`, which is a fleet-wide rotation nobody asked
  // for and nothing reports. Sorted rather than left where the object put it,
  // because the fallback belongs above the exceptions to it.
  const entries = Object.entries({ default: 0, ...map }).sort(([a], [b]) =>
    a === DEFAULT_KEY ? -1 : b === DEFAULT_KEY ? 1 : 0,
  );
  const taken = new Set(entries.map(([k]) => k));
  const free = allModels(src).filter((m) => !taken.has(m));
  return (
    <div className="flex w-full flex-col gap-1">
      {entries.map(([k, v]) => (
        <div key={k} className="flex items-center gap-1.5">
          <div className="w-[13rem] flex-none">
            <ModelPick
              value={k}
              // Its own name plus the unclaimed ones: a list that dropped the
              // current value would show the row's own key as no match.
              options={[k, ...free]}
              disabled={k === DEFAULT_KEY}
              onCommit={(name) => {
                if (!name.trim() || name === k) return;
                onWrite(Object.fromEntries(entries.map(([ek, ev]) => [ek === k ? name : ek, ev])));
              }}
            />
          </div>
          <CountAmount value={Number(v)} label={k} onWrite={(n) => onWrite({ ...map, [k]: n })} />
          {k === DEFAULT_KEY ? (
            <span className="w-7 shrink-0" />
          ) : (
            <Tip label="删掉这一行">
              <Button
                variant="quiet"
                size="sm"
                aria-label={`删掉 ${k}`}
                className="shrink-0"
                onClick={() => onWrite(Object.fromEntries(entries.filter(([ek]) => ek !== k)))}
              >
                <X className="size-3" />
              </Button>
            </Tip>
          )}
        </div>
      ))}
      <div className="flex items-center gap-1.5">
        <div className="w-[13rem] flex-none">
          <ModelPick
            key={`add-${entries.length}`}
            value=""
            options={free}
            onCommit={(name) => {
              if (name.trim()) onWrite({ ...map, [name.trim()]: 0 });
            }}
          />
        </div>
        <Meta>{free.length ? "选一个模型就多一行" : "填个模型 id 就多一行"}</Meta>
      </div>
    </div>
  );
}

/**
 * The three tiers, as three token caps.
 *
 * Same grid as 难度 → 模型 above it, empty first column and all: they are keyed
 * by the same three words, and two three-column blocks whose columns do not line
 * up is the one thing that makes them unreadable as the same three things.
 */
function Caps({ caps, onWrite }: { caps: Record<string, number>; onWrite: (v: unknown) => void }) {
  return (
    <div className={cn(TIER_GRID, "items-center gap-x-2 gap-y-1")}>
      <span />
      {TIERS.map((t) => (
        <Meta key={t}>{t}</Meta>
      ))}
      <span />
      {TIERS.map((t) => (
        <CountAmount key={t} value={Number(caps[t] ?? 0)} label={t} onWrite={(n) => onWrite({ ...caps, [t]: n })} />
      ))}
    </div>
  );
}

/**
 * Which CLI, and which model on it. Two settings, one decision, one row.
 *
 * Switching the CLI carries the model with it, and it must not: `gpt-5.6-luna`
 * on claude is a model that runtime cannot run, and this is by its own note the
 * most frequent model call in the system, so the failure arrives everywhere at
 * once. It moves to the new runtime's cheapest, which `difficultyModel` already
 * states — `trivial` is by definition the tier not worth a large model, so the
 * answer is in the config rather than in a price table nobody would update.
 */
function IndexModel({
  runtime, model, src, onRuntime, onModel,
}: {
  runtime: string;
  model: string;
  src: ModelSources;
  onRuntime: (v: string) => void;
  onModel: (v: string) => void;
}) {
  const byRuntime = modelsByRuntime(src);
  const runtimes = Object.keys(byRuntime).length ? Object.keys(byRuntime) : ["claude", "codex"];
  return (
    <div className="flex w-full items-center gap-2">
      <Segments
        value={runtime}
        onValueChange={(next) => {
          if (!next || next === runtime) return;
          onRuntime(next);
          const cheap = cheapest(src, next);
          if (cheap && cheap !== model) onModel(cheap);
        }}
      >
        {runtimes.map((r) => (
          <Segment key={r} value={r}>{r}</Segment>
        ))}
      </Segments>
      <ModelPick value={model} options={byRuntime[runtime] ?? []} onCommit={onModel} />
    </div>
  );
}

/**
 * The browser's own permission, asked for where the boss can see why.
 *
 * Deliberately a button rather than a prompt on load: a page that asks for
 * notifications before it has said anything worth being notified about is the
 * page everyone clicks 拒绝 on, and that decision is sticky.
 */
function Permission() {
  const supported = typeof Notification !== "undefined";
  const [state, setState] = useState(supported ? Notification.permission : "denied");
  return (
    <Field aria-labelledby="notify-perm">
      <FieldTitle id="notify-perm">桌面通知</FieldTitle>
      <FieldContent>
        {!supported ? (
          <Meta>这个浏览器不支持</Meta>
        ) : state === "granted" ? (
          <Meta>已开。面板在后台也会弹，浏览器整个关掉才收不到——那时重新打开会补上。</Meta>
        ) : state === "denied" ? (
          <Meta>被浏览器拒了。要开的话在地址栏左边的站点设置里改，然后刷新。</Meta>
        ) : (
          <Button size="sm" onClick={() => void Notification.requestPermission().then(setState)}>
            允许通知
          </Button>
        )}
      </FieldContent>
    </Field>
  );
}
