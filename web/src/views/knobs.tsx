import { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import { post, pull } from "../lib/api";
import { cn } from "../lib/utils";
import { Field, FieldContent, FieldGroup, FieldLabel, FieldTitle } from "../ui/field";
import { Switch } from "../ui/switch";
import { Tip } from "../ui/tooltip";
import { Meta } from "../ui/bits";

/**
 * The operating knobs, as rows.
 *
 * These used to live in `config/default.yaml` with a hundred lines of comments
 * around them, and those comments are the most expensive thing in that file —
 * every number is a measurement someone paid for. They come across as the `?`
 * on each row. A settings page that lists forty numbers with no reasons is a
 * page that gets a number changed once and never changed back.
 *
 * The server sends value, default and whether it was overridden; the labels and
 * the reasons live here, because they are copy.
 */

interface Knob {
  path: string;
  type: string;
  value: unknown;
  default: unknown;
  overridden: boolean;
}

export type KnobSection = "sched" | "models" | "turn" | "boxdefaults" | "notify";

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
    paths: ["difficultyModel", "indexModel", "contextWindow", "sliceBudgetTokens", "language"],
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

/** Label, and the reason the default is what it is. Both from the yaml this replaced. */
const COPY: Record<string, { zh: string; why?: string }> = {
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
    zh: "自动查收的难度档",
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
  indexModel: {
    zh: "索引/检索用的模型",
    why: "全系统调用最频繁的一个模型调用：纯摘要、不做决策、不用工具、不碰黑板。第一个该从贵订阅上挪走的就是它。",
  },
  contextWindow: {
    zh: "各模型的上下文窗口",
    why: "轮换 session 的分母。两个 CLI 在 turn 里都会报真实值，那个值优先；这张表管的是一个 session 的第一个 turn。写死成 200k 的那阵子，强模型一直在 1M 窗口的 12% 处轮换，每轮换一次就扔掉一次花钱建起来的缓存前缀。",
  },
  sliceBudgetTokens: {
    zh: "每片的 token 上限",
    why: "取自本仓库 16 个真实切片：trivial 均值 4.0M（有一个 12.0M 跑飞的），normal 均值 7.3M 尾部 16.1M。卡在「跑完的最坏一片」之上、「跑飞那一片」之下——这个上限是给已经迷路的 agent 用的，不是给今天状态不好的那个。改了只影响新切片。",
  },
  language: {
    zh: "对外语言",
    why: "管 journal / 频道消息 / 问你的问题 / 状态摘要。代码、commit message、分支名、PR、错误信息永远是英文。改这一项会让全舰队轮换一次 session——它在缓存前缀里。",
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
    zh: "上下文用到多少就换会话",
    why: "兜底触发器，真正的轮换点是切片做完——那是个干净的语义边界，交接也便宜。",
  },
  ctxBudgetChars: {
    zh: "ctx query 答案上限",
    why: "约等于 4k token。这个答案会落进 transcript，而 transcript 这个会话剩下的每一轮都要重读一遍——所以慷慨的答案在问题被回答完很久之后还在收费。",
  },
  unreadDigestThreshold: { zh: "未读消息摘要条数", why: "一轮最多把多少条频道消息塞进 delta。" },
  feedbackSedimentThreshold: { zh: "同一抱怨几次变成规则", why: "同一件事说到第 N 次，它就该是项目的一条规则，而不是第 N+1 次抱怨。" },
  gateRetries: { zh: "闸门重试次数", why: "同一片连着几次没过就升级给人，而不是一直重试同一条路。" },
  leaseTimeoutMs: {
    zh: "单次闸门命令上限",
    why: "大项目的一次编译是小时级；完全没有上限的话，一个挂死的 build 会永远占着 lease 槽位，而槽位是全局的、少的——一条卡死的命令能让整个舰队再也过不了闸门。",
  },
  installTimeoutMs: {
    zh: "装依赖上限",
    why: "和 lease 同一个量级，因为是同一类东西——真的在编译。卡太紧的失败长得像「这个项目坏了」而不像「超时了」，而组在两种情况下都一样卡住。",
  },
  "sandbox.server": {
    zh: "沙盒服务器地址",
    why: "opensandbox-server 在哪。必须是 dns+nft 模式，否则凭据注入静默失效。它不一定在这台机器上——Tailscale 上的一台或者一台云机器都行，SDK 只跟它说 HTTP。",
  },
  "sandbox.image": {
    zh: "默认镜像",
    why: "只认两个来源：我们发布的 ghcr.io/pamin-labs/…，和没有 registry 前缀的本机 build。这里面跑的是 agent，而 agent 手里有你的代码——换一个来路不明的镜像就是把整条边界交给别人，而且从面板上看不出任何异常。",
  },
  "sandbox.cpu": {
    zh: "CPU",
    why: "留空 = 宿主核数的 1/4。SDK 自己的默认值是 \"1\"，这个仓库的 tsc --noEmit 因此要 7.6 秒（6 核是 3.2 秒）。",
  },
  "sandbox.memory": { zh: "内存", why: "每个沙盒的内存上限。" },
  "sandbox.ttlSeconds": {
    zh: "沙盒存活时间",
    why: "turn 开始时会续期，所以这是「没人管了多久回收」，不是任务时长上限。",
  },
  "sandbox.denyDomains": {
    zh: "禁止访问的域名",
    why: "黑名单而不是白名单——白名单才是穷举不完的那个（每个 registry、每个文档站）。凭据安全不靠它：真 token 在 sidecar 里，沙盒里是格式合法的假值。",
  },
  "sandbox.cacheDirs": {
    zh: "共享缓存目录",
    why: "所有沙盒共享的宿主目录，「容器里的挂载点: 宿主路径」。只放包管理器缓存。实测这个仓库第二个组的 bun install：不共享 2.9 秒，共享 1.2 秒——小是因为仓库小，到 monorepo 上是分钟级差别。默认关，因为这个仓库最惨的一次事故就是所有 worktree 共用一份 node_modules，两个闸门同时装，组把 EEXIST 当成自己的 build 坏了。另外沙盒服务端的 allowed_host_paths 也得列上这个路径。",
  },
  notifyWebhook: {
    zh: "转发到 webhook",
    why: "留空就只有这个页面会叫你。填了的话每条通知会 POST 一份 JSON（title / message / url）过去——ntfy、Bark、群机器人、你今天下午写的东西，都行。出站前会过一遍脱敏，因为这是唯一一个把内容送出这台机器的通道。",
  },
  skillsDir: {
    zh: "技能暂存目录",
    why: "勾中的技能复制到这里，每个沙盒只读挂上去。改这里要同步改沙盒服务端的 allowed_host_paths，否则开容器直接失败——而那是响的失败，比一个静默的空目录好得多。",
  },
};

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

  const write = async (path: string, value: unknown) => {
    // Destructured: `post` returns `{ok, text}`, so `if (!ok)` on the object
    // itself is always false and a refused write would still have said 已保存.
    const { ok } = await post("/api/settings", { path, value });
    if (!ok) return;
    setSaved(new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }));
    await load();
  };

  const spec = SECTIONS[section];
  const rows = (knobs ?? []).filter((k) => spec.paths.includes(k.path));
  rows.sort((a, b) => spec.paths.indexOf(a.path) - spec.paths.indexOf(b.path));

  return (
    <>
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-[0.9375rem] font-semibold">{spec.zh}</h2>
          <Meta>{spec.note}</Meta>
        </div>
        {/* Where a save button would be. There is none: a field is written when
            it loses focus, and this says the write landed. */}
        {saved && <Meta>已保存 {saved}</Meta>}
      </div>
      {section === "notify" && <Permission />}
      {knobs === null ? (
        <Meta className="block py-2">读取中…</Meta>
      ) : (
        <FieldGroup className="mt-2">
          {rows.map((k) => (
            <Row key={k.path} knob={k} onWrite={write} />
          ))}
        </FieldGroup>
      )}
    </>
  );
}

function Row({ knob, onWrite }: { knob: Knob; onWrite: (path: string, value: unknown) => void }) {
  const copy = COPY[knob.path] ?? { zh: knob.path };
  const id = `knob-${knob.path.replace(/\W/g, "-")}`;
  const label = copy.why ? (
    <Tip label={copy.why}>
      <span className="underline decoration-dotted underline-offset-2">{copy.zh}</span>
    </Tip>
  ) : (
    copy.zh
  );

  return (
    // A boolean's control names itself; everything else has a real label to click.
    <Field {...(knob.type === "boolean" ? { "aria-labelledby": id } : {})}>
      {knob.type === "boolean" ? (
        <FieldTitle id={id}>{label}</FieldTitle>
      ) : (
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
      )}
      <FieldContent className="flex flex-row items-center gap-2">
        <Value id={id} knob={knob} onWrite={onWrite} />
        {/* Neutral, not the accent: the accent means "waiting on you" and this is
            only "not the shipped value". */}
        {knob.overridden && (
          <button
            type="button"
            className="flex items-center gap-1 text-[0.6875rem] text-ink-3 hover:text-ink-2"
            onClick={() => onWrite(knob.path, null)}
            title="恢复默认"
          >
            <RotateCcw className="size-3" />
            已改
          </button>
        )}
      </FieldContent>
    </Field>
  );
}

function Value({ id, knob, onWrite }: { id: string; knob: Knob; onWrite: (p: string, v: unknown) => void }) {
  if (knob.type === "boolean") {
    return <Switch id={id} checked={Boolean(knob.value)} onCheckedChange={(v) => onWrite(knob.path, v)} />;
  }
  // Objects and arrays are edited as JSON. They are `difficultyModel`,
  // `contextWindow` and two others — tables keyed by model id, where a form with
  // fixed rows would be a form that cannot express a model we have not shipped.
  const json = knob.type !== "number" && knob.type !== "string";
  const text = json ? JSON.stringify(knob.value) : String(knob.value ?? "");
  return (
    <input
      id={id}
      defaultValue={text}
      key={text}
      spellCheck={false}
      className={cn(
        "min-w-0 flex-1 rounded-sm border border-rule bg-paper px-1.5 py-0.5 font-mono text-[0.75rem]",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent",
      )}
      onBlur={(e) => {
        const raw = e.currentTarget.value.trim();
        if (raw === text) return;
        if (knob.type === "number") {
          const n = Number(raw);
          if (Number.isFinite(n)) onWrite(knob.path, n);
          return;
        }
        if (!json) return void onWrite(knob.path, raw);
        try {
          onWrite(knob.path, JSON.parse(raw));
        } catch {
          // Leave it as typed; the row still shows what the server has.
        }
      }}
    />
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
    <FieldGroup className="mt-2">
      <Field aria-labelledby="notify-perm">
        <FieldTitle id="notify-perm">桌面通知</FieldTitle>
        <FieldContent className="flex flex-row items-center gap-2">
          {!supported ? (
            <Meta>这个浏览器不支持</Meta>
          ) : state === "granted" ? (
            <Meta>已开。面板在后台也会弹，浏览器整个关掉才收不到——那时重新打开会补上。</Meta>
          ) : state === "denied" ? (
            <Meta>被浏览器拒了。要开的话在地址栏左边的站点设置里改，然后刷新。</Meta>
          ) : (
            <button
              type="button"
              className="rounded-sm border border-rule px-2 py-0.5 text-[0.75rem] hover:bg-rail"
              onClick={() => void Notification.requestPermission().then(setState)}
            >
              允许通知
            </button>
          )}
        </FieldContent>
      </Field>
    </FieldGroup>
  );
}
