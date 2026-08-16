<img src="web/icon.png" alt="" width="76" height="76">

[English](README.md) · [简体中文](README.zh-CN.md)

# orchestrator

**一人公司的那支 AI 团队。**

说一句你想要什么，一支专业团队自动组建、开工、审完，最后递给你一个 PR。
你只做三件事 —— 说、批方案、合并。其余全部发生在你不用看的容器里。

```
●  你说一句话
│
○  它读代码、拆片、出方案
│
●  你批              ← 不对就打回，它重出一版
│
○  它开一个组，写码、自查、跑你的测试、交给 QA 复核
│
○  组外的 Auditor 读完整个分支，然后开 PR
│
●  你合

●  你 —— 三件事      ○  它 —— 其余全部
```

## 为什么用它

**让 AI 写代码这件事，早就能用了。** 一个 agent 给不了你的是：在你拍板之前有人说
这方案不对、审代码的人不是写代码的人、三十条悬而未决的事有人替你端着，最后只递到
你面前一个问题。这些岗位它给你配齐。

**而且它动不了你的机器。** 每个组在自己的容器里干活，用自己的克隆。
agent 真跑了 `rm -rf`，炸的是一个容器。

## 跑起来

需要 [Docker](https://docs.docker.com/get-started/get-docker/)、
[`uv`](https://docs.astral.sh/uv/)，以及一个 Claude 和/或 ChatGPT 订阅。
不需要 `bun`，不需要 `node`，不需要任何工具链 —— orchestrator 就是一个编译好的
二进制。Docker 是**沙盒**要的，它本来就是干这个的。

**1. 沙盒服务器**，在有 Docker 的那台机器上跑一次：

```bash
docker pull opensandbox/egress:v1.1.6             # v1.1.4 会搞坏 scoped npm 包
uvx opensandbox-server --config ~/.sandbox.toml   # [egress] mode 要是 "dns+nft"
```

**2. orchestrator 本体。** 一个压缩包，不需要任何工具链。

<details open><summary><b>Linux</b> —— x64 · arm64</summary>

```bash
curl -fsSL https://github.com/pamin-labs/orchestrator/releases/latest/download/orch-server-linux-x64.tar.gz | tar xz
cd orch-server-*-linux-x64
./orch-server
```
</details>

<details><summary><b>macOS</b> —— Apple 芯片 · Intel</summary>

```bash
curl -fsSL https://github.com/pamin-labs/orchestrator/releases/latest/download/orch-server-darwin-arm64.tar.gz | tar xz
cd orch-server-*-darwin-arm64
xattr -dr com.apple.quarantine .                  # 没签名，不去掉 Gatekeeper 不让跑
./orch-server
```

Intel 的 Mac 用 `orch-server-darwin-x64.tar.gz`。
</details>

<details><summary><b>Windows</b> —— x64</summary>

```powershell
Invoke-WebRequest -Uri https://github.com/pamin-labs/orchestrator/releases/latest/download/orch-server-windows-x64.zip -OutFile orch.zip
Expand-Archive .\orch.zip -DestinationPath .
cd orch-server-*-windows-x64
.\orch-server.exe
```

沙盒服务器是 Linux only 的（出站过滤用 `nft`），所以在 Windows 上它跑在 WSL 里、
挨着 Docker Desktop 的 daemon：在 WSL 里 `uvx opensandbox-server`。挂载路径会替它
翻译 —— 这个进程写成 `C:\orch\skills` 的路径，在它那边是 `/mnt/c/orch/skills`，
而要写进 `allowed_host_paths` 的正是翻译后的那个。设置 → 环境 会把那一行原样打出来。
</details>

起来的时候它自己会把地址打出来。只绑 loopback 是故意的：面板前面没有登录，
能访问到它的人就是你 —— 要放到别处，前面加一层带鉴权的反向代理。`ORCH_HOST`
和 `ORCH_PORT` 能改，`config/default.yaml` 里是同样两项、改了长期有效。

agent 镜像由沙盒服务器在第一次建容器时自己拉，不用手动 pull。

<details><summary>或者从源码跑</summary>

```bash
bun install
bun start
```

需要 [`bun`](https://bun.sh)。上面那两行沙盒服务器照样要。

</details>

然后在面板里做一次：

1. **登录。** 两边都是在容器里跑官方 CLI，本机什么都不用装。贴 token 或 API key 也行。
2. **连 GitHub。** 一个设备码。注意**授权不等于安装**：安装才是你挑它能碰哪些仓库的
   地方，没装之前仓库列表是空的。面板认得出这个状态，会告诉你。
3. **加项目**，从列表里挑。本机不会多出任何东西，项目就是一个 GitHub 坐标。
   第一个组把它 clone 下来，然后读代码推出你的闸门（测试、typecheck、lint），
   写进项目配置，你随时能改。

## 这支团队

- **Chief of Staff** — 给你干活，不给项目干活。所有悬着的问题攒成一条消息，blocker 直接放行。
- **Dispatcher** — 一句话进去，方案出来。先数你到底提了几件事，再拆成一片一片能单独验收的小改动。
- **Architect** — 常驻，在所有组之上。给每个组分定路径，两个组撞不上。然后用两行写清这方案哪里不对，你批之前就看到。
- **PM** — 一个组唯一的对话入口。你说一句，一个 agent 回你。
- **Engineer** — 组里唯一写代码的。被串行化，写冲突不存在。
- **QA** — 拿 diff 和测试结果，对着验收标准验其中一片，**刻意读不到**整个仓库。
- **Auditor** — 从组外审完成的分支，换一个模型。卡上承诺的做没做、有没有另起炉灶造一套仓库里已经有的东西、它自己写的工作记录和真实 diff 对不对得上。
- **Scribe** — 照着做完的 diff 写 commit 和 PR。它读的是真的改了什么，不是当初打算改什么 —— 一年后翻 log 的人要的是这个。
- **Librarian** — 维护一份项目入门说明和一份有上限的经验清单，新 agent 一上来就懂这个项目。
- **Bootstrap** — 把干净检出弄到能构建，从 lockfile 和 CI 配置里推出安装步骤。

加一个角色是写一个 YAML，不是改代码。

## 怎么知道它没在糊弄你

用过 AI 写代码的，下面五件事都遇到过。

**「做完了！」—— 其实没有。**
每一片必须先跑通你项目自己的命令（测试、typecheck、lint）才算数。看退出码，不看它
怎么说。没过就退回去重做，不会到你面前。也不给你百分比：只显示哪几项过了，
LLM 报的进度是猜的。

**它自己审自己的活。**
这里审两遍，而且审的都不是写的那个：QA 只看这一片的 diff，Auditor 在组外、
换一个模型、读整个分支。

**它说改了 A，其实动了 B。**
每片结束时系统把「它声称改了什么」和 git 里真实的 diff 对一遍。对不上当场就暴露，
不用等你读 PR 才发现。

**第 1 轮记得规矩，第 20 轮就忘了。**
所以凡是能用代码卡住的都不写进提示词：哪个组能碰哪些文件、笔记多长、
哪个状态卡住了该有谁去推。提示词会被忘，`if` 不会。

**它让你批的东西，长到你根本不会看。**
要你点头的那张卡硬上限 12 行，超了系统直接退回重写。你批的是方向和验收标准，
不是实现方案。

## 沙盒挡什么，不挡什么

**挡住三件事。**

- **动你的电脑。** agent 的容器里只有这个项目的一份克隆，你别的项目、你的家目录、
  你的工作副本，它够都够不到。
- **拿到你的真 token。** 容器里放的是格式对但用不了的假值。真 token 在出网那一刻
  由容器外的一个代理替换进去，容器自己从头到尾看不到它长什么样。
- **往你仓库里推东西。** 组里那份 GitHub 凭据只够拉代码，推不上去。推是另一个
  容器干的，那个容器里没有 agent。

**挡不住数据出去。** 网络默认是放行的，因为 agent 要查文档、装依赖。也就是说
凭据它拿不到，但**你的代码内容它能发到任何地方**。介意的话，第一次跑之前先在
`sandbox.denyDomains` 里配好黑名单。

**同一个组内部不隔离。** 一个组共用一个容器，隔离是组与组之间的。

## 现状

早期，而且不藏着：**还没有一个需求从头走到尾跑通过。** 不是「没用真账号跑过」，
是任何形式的完整一遍都没有。每个零件单独对着真东西量过，每个阶段单独用替身测过 ——
这是两种证据，而哪一种都不等于第三种。

而 bug 全是从这个缺口里出来的，三个都长得一模一样：**看起来完全正常。**
一个目录报告挂载成功，其实是空的；一份代码索引渲染得好好的，内容全丢了；
容器传回来的多行输出被拼成了一行，于是每个按行去读它的地方都什么也没读到。
没有一个是测试发现的，全是量出来的。

MIT 协议。

## 更多

`bun test` 跑全部 check。设计在 [`docs/project/plan.md`](docs/project/plan.md)，
所有用代价换来的结论在 [`docs/project/progress.md`](docs/project/progress.md) 和 [`docs/adr/`](docs/adr/)，
改代码之前先读 [`CLAUDE.md`](CLAUDE.md)。

基于 [OpenSandbox](https://github.com/opensandbox-group/OpenSandbox)。
跑的是真的 `claude` 和 `codex` CLI，不是我们自己实现的。
