# orchestrator

一人公司 AI 员工调度系统。老板丢想法，AI 分组接管拆解/架构/编码/测试/审阅/PR，老板只批 DRAFT、查收切片、merge。

## 开工前先读（顺序固定）

1. **`PROGRESS.md`** —— 当前做到哪、下一步是什么、有没有偏离设计
2. **`PLAN.md`** —— 权威设计文档。**设计变更改这里**，不改 `~/.claude/plans/`
3. `docs/decisions/` —— 开发期的设计变更记录（和系统运行期的 `note(kind=decision)` 不是一回事）

**每完成一个可验证单元就更新 `PROGRESS.md`**（有 check 变绿，或手动走通一步），不是每改一个文件。

## 技术栈

- **bun + TypeScript**，单进程：HTTP + SSE + `bun:sqlite` + 子进程管理
- **HTTP = hono，校验 = zod**（经 `@hono/standard-validator`）。协议层在 `src/http/`（响应构造、handler 形状、校验适配、content-type 闸），业务在 `src/api/`：`orch/` 是 agent 调的，`panel/` 是浏览器调的。**handler 不认识框架** —— 签名是 `(ctx, req, params, data)`，测试里四个参数直接调，不用起服务器；`route()` 是唯一知道 hono 存在的地方，同时把 schema 和 handler 接给 TS，改了 schema 忘了 handler 直接编译不过
- **面板的类型从服务端推出来**，不手写：`type State = ReturnType<typeof snapshot>`，行的形状是 `src/api/panel/shapes.ts` 里的 zod。`import type` 构建时擦除，不会把服务端代码打进浏览器包
- **web = React + Tailwind v4 + shadcn/ui**（Radix 行为层），`bun run build:web` 出 `web/dist`。视觉语言是自己的（见 `DESIGN.md`），shadcn 只负责行为：焦点陷阱、Esc、aria、菜单、toast。手写过一遍，不值得
- **页面仍然不 fetch 任何外部资源** —— 字体用本机已有的，脚本样式只从 `web/dist` 出，`test/smoke.test.ts` 守着
- agent runtime = **CLI 子进程**（`claude -p` / `codex exec`），不用 Agent SDK
- agent ↔ orchestrator = **`orch` CLI**，不用 MCP、不用 sentinel JSON。传输是**文件信箱**（sandbox 里写请求文件，宿主轮询回信）—— `host.docker.internal` 只有 Docker Desktop 有，Linux 没有
- 沙盒 = **一个组一个 OpenSandbox 容器**（`docs/decisions/005`）。宿主碰不到，宿主只通过 `orch` 暴露有限动作。CLI 在里面用 `--dangerously-skip-permissions` —— 容器已经是边界，进程内再自我约束就是那堆静默拒绝的来源
- 凭据 = **egress sidecar 的 Credential Vault**。真 token 永不进沙盒，沙盒里是格式合法的假值，出站时 sidecar 替换 header

## 命令

```bash
bun install
bun run src/server.ts        # 起 orchestrator
bun test                     # 全部 check
bun test test/xxx.test.ts     # 单个
```

## 四个一等公民（改代码前必须清楚）

| 实体 | 是什么 |
|---|---|
| `job` | 一切**将要**发生的事 + 唯一调度器。intercept / park / 预算熔断都是它的用法 |
| `event` | 一切**已经**发生的事，append-only |
| `note` | 黑板静态部分（fact / decision / journal / retro / onboarding / lesson） |
| `task` / `slice` | 工作单元 + 状态机；`slice` 是可独立验收的交付单元 |

**没有 mail 表**（合入 `event`）。**没有独立的 group 实体**（= task 子树 + branch + sandbox + roster + 预算）。

## 不许违反的硬约束

1. **注入的 delta 一律追加到最新一条 user message 末尾。** 塞进 system prompt 或历史前部会击穿 prompt cache，成本翻 3-5 倍且功能完全正常 —— 最隐蔽的故障。所有 prompt 组装必须走 `src/prompt/assemble.ts`，回归测试是 `test/cache-position.test.ts`。
2. **`orch lease` 永不接受自由命令。** 资源是 `resource` 表里预定义的模板，agent 只能选资源名 + 传经 `arg_schema` 校验的参数。以前的理由是「Runner 跑在 host 上有真权限，这是沙盒的唯一缺口」；现在它跑在组自己的沙盒里，理由反过来了 —— **`orch` 是 agent 唯一的接口**，它的校验就是整条边界。
3. **凡能用 `if` 拦的，绝不写进 prompt 求 agent 自觉。** journal ≤6 行、DRAFT 卡 ≤12 行、沙盒边界、看门狗、file ownership、对账 —— 全部确定性强制。提示词会在第 20 个 turn 被忘掉。
4. **组件行为不许自己造，有 shadcn 就用 shadcn。** 优先级：shadcn 组件 > 自己造 > 裸 HTML 标签。dialog / menu / toast / 命令面板 / accordion / button / input 一律走 shadcn（Radix + cmdk + sonner）。手写过一遍 confirm、toast、下拉，结果是没有焦点陷阱、Esc 不响应、aria 全缺 —— 视觉语言是我们的（`DESIGN.md`），行为不是我们该发明的。加组件先看 shadcn 有没有。
5. **要老板做的决定必须把证据摆在按钮旁边。** 查收给 diff + QA 判词 + 闸门日志；不可逆动作（确认已合入）先让服务端向 GitHub 核对；被卡住的状态（预算烧穿、退回的 DRAFT、代答）必须有出路按钮。只给标题就让人批 = 橡皮图章，前面三道闸白跑。
6. **`if` 和 prompt 说的话必须一致，不一致时模型听 `if`。** 改校验器时同步改对应的 role prompt，反过来也一样。实测：dispatcher prompt 写着「真的不可分就交一片，凑三片更糟」，而校验器拒收 1-2 片 —— 模型只能凑，还把凑出来的切片当风险写在自己卡上。**prompt 给的许可如果校验器不认，就是在教模型撒谎。**
7. **每个状态都必须有人推。** 加状态 = 在 `src/mech/ops/invariants.ts` 加一行：什么必须成立 / 谁推它出去（`driver`）/ 需要的话一个幂等 repair。`src/states.ts` 是唯一的状态清单，`test/invariants.test.ts` 断言两者对齐 —— 加了状态不填表，`bun test` 直接红。

   为什么：**每一条 watchdog 规则都是一次事故换来的，而它们形状完全一样** —— 某个转移只有一条代码路径会触发，那条路径没跑，状态就永久停住，而且**看起来是健康的**（组 RUNNING、有 agent、哪儿都没报错）。实测过的：六个组卡在过期基线上；六个组卡在一个 `--settings` 路径 bug 上；一个组每片都查收了却没人把分支交出去；一个 PAUSED 却没有 `paused_at` 的组对所有定时器隐形。表把「又发现一个」变成「表里有个空格」。

   **表里只放活性（liveness）：谁推。** 健康检查（turn 超时、原地打转、预算、env_suspect）留在 `watchdog.ts` —— 那是「它还好吗」，不是「有没有人在推它」。两者混在一起，任何一边都会变成垃圾堆。

8. **解决过的问题不要再解决一遍。** 路由、校验、glob、YAML、MIME、日期 —— 这些都有成熟答案，我们该花时间的是这个项目的逻辑和这个页面的设计。**不要怕加依赖**，怕的是手写一份将来没人维护的半成品。硬约束 4 是这一条在组件上的特例。

   **理由不是「代码更短」，是「手写的那份是错的」** —— 实测三条，每一条都是这么发现的：
   - 手写的 glob 让 `src/a/**/*.ts` 覆盖 `src/a/b.js`，而它的下游是 turn 结束后回滚越界文件。判错 = 越界文件不回滚，而组全程看起来健康。换 `Bun.Glob`。
   - lease 的 int 校验是 `Number(raw)`，于是 `true`→1、`""`→0、`" 3 "`→3 —— 一个复选框和一个空字段都变成了命令行上「有人选的」数字。而这是沙盒边界（硬约束 2）。换 zod 显式 union。
   - 手写的 frontmatter 解析器把 `>-` 按 `|` 折叠，还会命中正文里的 `description:`。`Bun.YAML.parse` 三个文件之外就在用。

   **但也不是有库就用。** 同一轮里查过之后明确不换的：`node:util` 的 `parseArgs` 要每个子命令声明选项，配置比它替掉的 50 行还多；`shell-quote` 会把 `>` `&&` 解析成操作符对象，而 lease 模板**根本不过 shell**，那是多出来的语义、方向反了；`z.coerce.boolean()` 把非空字符串一律当 true，`"false"` 会变成 `true` —— **用库不等于用它最顺手的那个导出**，尤其在边界上。

   判据一句话：**这个手写版有没有一种情况是错的？** 有 → 换。只是长 → 先问它有没有一个库给不了的性质（一句写给 agent 看的错误信息、一次保留注释的往返、一条安全边界）；没有才换。

9. **修一个 bug，是让这一类 bug 从此不可能再发生。** 只把这一处改对，是把同一件事留给下一个人重新踩。修完要问的是：**同样的错法还能从哪些地方进来？** 然后把入口本身堵掉。

   四种堵法，按强度排（能用上面的就别用下面的）：

   1. **让编译器拦。** `say()` 的 key 标着 `keyof typeof EN`，而 `EN` 被标注成 `Record<string, string>`，于是那个签名从写下来那天起就等于 `string` —— 全代码库任何调用方传任何 key 都能过，而 `say` 对不认识的 key 的处理是 `String(key)`：不抛、不记日志，把字面量 `wd.stalledd` 放进老板的信息流。删掉那个标注，联合类型就是真的了。同一类：`resolveGroup(ref: unknown)` 手写窄化 zod 已经保证的东西；一个 `any` 不是省了一次标注，是关掉了一处检查。
   2. **让类型系统不可能表达错的状态。** 停组要同时写 `status` / `paused_at` / `pause_reason`，十四处各写各的，硬约束 7 就是其中三处忘了第二个换来的。收成 `hold()` / `release()` 之后，忘不了 —— 因为没有地方可以忘。
   3. **让不变量表管住。** 加状态就得在 `src/mech/ops/invariants.ts` 填一行（硬约束 7）。但注意这条本身也会失效：`runInvariants` 只跑了八张表里的两张，`PROJECT.repo_held` 的 repair 写了、审了、`uncovered()` 还检查过它存在 —— 一次都没执行过。**「有没有这一行」和「这一行有没有跑」是两件事，两件都要检查。**
   4. **实在拦不住，留一条扫源码的检查。** `test/paused-at.test.ts` 扫 `src/**` 找裸的 UPDATE，`test/knob-units.test.ts` 断言凡是叫 `*Ms` 的旋钮必须在单位表里。这类检查在**写下那一行的时候**就红，而不是在它真的出事的那个凌晨。

   **写检查要钉住性质，不是钉住这一次的症状。** 上下文窗口那个 map 新增行写 `0`，而 schema 是 `.positive()` —— 于是新模型永远加不进去。检查不是「default 现在等于 200000」，是「面板给新行的那个初值，必须能过它自己的 schema」，三个 map 型旋钮各跑一遍。下一个加进那张表的旋钮，自动被覆盖。

   **判据：如果同样的错法明天从另一个文件进来，今天这个改动会拦住它吗？** 不会 → 这个 bug 只修了一半。

## 开工前挂档（按任务难度）

**启动时**先挂 `pua` 档位，再动手。挑不动就往难的那档挑 —— 多跑一个命令的成本，远小于第 20 个 turn 才发现方向错了。

| 这次要干的事 | 启动命令 |
|---|---|
| 日常改动、查 bug、一两个文件 | `/pua`（核心引擎：三条红线、L0-L4、7 项清单） |
| 执行一个已经定好方案的子任务 | `/pua:p7`（方案驱动 + 3 问自检） |
| 写 prompt、带一队 agent（改 `roles/*.yaml`、调度、编排） | `/pua:p9` |
| 定架构、切模块边界、动 `PLAN.md` 的形状 | `/pua:p10` |
| 大任务放着自己跑 | `/pua:loop`（最多 30 轮） |
| 派给子 agent / 短会话，要把要点塞进去 | `/pua:shot` |

**动手时**再按领域挂 skill：

- 全部：`/ponytail:ponytail`。
- 前端：`/shadcn`（先查有没有现成组件，硬约束 4）+ `/impeccable <critique|layout|polish|harden|clarify>` + `/frontend-design`。
- 状态机 / 调度 / 模块边界：`mattpocock-skills:codebase-design`；方案有分歧先 `mattpocock-skills:grilling` 打一遍，结论落 `docs/decisions/`。

**收尾**：`/ponytail:ponytail-review`（只抓过度设计）或 `/code-review`（抓正确性）过一遍。

## 代码风格

- **写完用 `/ponytail:ponytail` 过一遍**（改代码、加依赖、做设计都算）。先问「这需要存在吗」，然后 stdlib / 已有依赖 / 一行 / 最小实现。不加只有一个实现的接口，不为「以后」搭脚手架。deliberate 的取巧用 `ponytail:` 注释标注天花板和升级路径。
- **caveman lite**：注释和文档去冠词去客套。代码、commit message、PR、错误信息**用英文**。
- 非平凡逻辑留一条 runnable check（`bun test`，不上框架、不写 fixture 地狱）。

## 有现成的就用现成的，别自己造

**先找，再写。** 顺序是：GitHub 官方能力 > 官方 action / CLI > 已装的依赖 > 自己写。这条和「代码风格」那节的 ponytail 梯子是同一条规则，只是它最常在**基础设施**上被违反 —— 那里自己写一份看起来最快。

实测过的两次：

- 发版说明本来写了一个 150 行的脚本去调 `generate-notes` 再重新分组。而 `gh release create --generate-notes` **本来就会**列出合入的 PR 和第一次贡献的人 —— 那就是这个功能本身。脚本删了。
- lint 一度想配 eslint 全家桶。`bunx oxlint` 一个二进制、零配置，`.oxlintrc.json` 只写了三条真正要改的规则。

判断标准不是「能不能自己写」，而是：**这段代码存在的理由，是不是只有「我没去找」。**

反过来也成立：为了省几行而引一个新依赖同样是错的（梯子第 5 级）。现成的意思是**已经在手上的、或者官方的**，不是「npm 上有」。

## 提交：用 `/git-commit`

**skill 在仓库里**（`.claude/skills/git-commit/`），clone 就有，不依赖谁的个人安装。它是这一条的完整版；这里只留必须知道的：

```
<type>(<scope>): <subject>

<body>

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: <session url>
```

- **标题说的是发现，不是 diff。** 读 log 的人在问「这为什么是这样」，而一个描述改动的标题回答不了任何他看不见的东西。`fix(sandbox): update mount path` 没有信息；`fix(sandbox): the skills mount was empty on macOS, and nothing could say so` 有。
- **正文说失败长什么样** —— 不是你改了什么（diff 里有），是它的代价、它怎么呈现、以及**为什么修在这一层**。「修在共享函数里而不是每个调用点，所以下个月加的第五个调用者也被覆盖」这句话，是阻止这个修复被撤销的那句话。
- **数字胜过形容词**：`179 on the host, 0 in the container` 是提交；「修好了挂载」不是。
- 提交前 `bunx tsc --noEmit -p .` 和 `bun test` 必须绿。多 agent 同时改树时**按文件名 stage**，`git add -A` 会把别人的半成品扫进来。

## 这个项目用到的 skill —— 缺了就装，别手做

新贡献者 clone 下来什么都没有。**agent 自己检查、自己装**，不要让人肉照着规则模仿 —— 那正是硬约束 3 说的「凡能用 `if` 拦的绝不写进 prompt 求自觉」的同一个道理：一个装好的 skill 是确定性的，一个「记得照 ponytail 的规矩来」不是。

先看有没有：`npx skills list`，或 `/plugin`。缺哪个装哪个：

```bash
npx skills add DietrichGebert/ponytail      # /ponytail:ponytail、/ponytail:ponytail-review
npx skills add tanweai/pua                  # /pua 全家（p7 / p9 / p10 / loop / shot）
npx skills add EveryInc/compound-engineering-plugin   # /code-review
npx skills add anthropics/skills            # frontend-design、mattpocock-skills 等官方那批
```

`git-commit` 不用装 —— 它在这个仓库里（`.claude/skills/git-commit/`），clone 就有。

`shadcn` 和 `impeccable` 是个人 skill，来源不在 marketplace 里，用 `npx skills find shadcn` / `npx skills find impeccable` 找。**`shadcn` 尤其别跳过**：硬约束 4 说「有 shadcn 就用 shadcn」，而判断「有没有」要靠它去查注册表。

装完 `npx skills list` 确认。

## 运行期产物的语言

`output.language` 配置（默认中文）管 journal / 频道消息 / 问老板的问题 / 状态摘要。
code / commit message / branch 名 / PR title+body / 错误信息**永远英文**。
