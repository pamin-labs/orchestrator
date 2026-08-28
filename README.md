<img src="web/icon.png" alt="" width="76" height="76">

[English](README.md) · [简体中文](README.zh-CN.md)

# orchestrator

**An AI team for a company of one.**

Say what you want. A team assembles around it, builds it, reviews it, and hands
you a pull request. You do three things — say it, approve the plan, merge.
Everything else happens inside containers you never have to look at.

```
●  you say one sentence
│
○  it reads the repo, splits the work, drafts a plan
│
●  you approve            ← or send it back; it writes another
│
○  it opens a group: writes code, self-checks, runs your tests, hands it to QA
│
○  an auditor outside the group reads the branch, then opens the PR
│
●  you merge

●  you — three things     ○  it — everything else
```

## Why

**Getting code out of an AI already works.** What you can't get from one agent is
a second opinion before you commit to a plan, a reviewer who didn't also write
the thing, or someone to hold thirty open threads so that one question reaches
you. That is what this staffs.

**And it can't touch your machine.** Every group works in its own container with
its own clone. If an agent runs `rm -rf`, it happens to a container.

## Quickstart

Needs [Docker](https://docs.docker.com/get-started/get-docker/),
[`uv`](https://docs.astral.sh/uv/), and a Claude and/or ChatGPT subscription.
No `bun`, no `node`, no toolchain — the orchestrator is one compiled binary, and
Docker is required for the *sandboxes*, which is what it was always for.

**1. The sandbox server**, once, on the machine with Docker:

```bash
docker pull opensandbox/egress:v1.1.6             # v1.1.4 breaks scoped npm packages
uvx opensandbox-server --config ~/.sandbox.toml   # [egress] mode = "dns+nft"
```

**2. The orchestrator.** One archive, no toolchain.

<details open><summary><b>Linux</b> — x64 · arm64</summary>

```bash
curl -fsSL https://github.com/pamin-labs/orchestrator/releases/latest/download/orch-server-linux-x64.tar.gz | tar xz
cd orch-server-*-linux-x64
./orch-server
```
</details>

<details><summary><b>macOS</b> — Apple silicon · Intel</summary>

```bash
curl -fsSL https://github.com/pamin-labs/orchestrator/releases/latest/download/orch-server-darwin-arm64.tar.gz | tar xz
cd orch-server-*-darwin-arm64
xattr -dr com.apple.quarantine .                  # unsigned; Gatekeeper otherwise refuses
./orch-server
```

Intel Macs: `orch-server-darwin-x64.tar.gz`.
</details>

<details><summary><b>Windows</b> — x64</summary>

```powershell
Invoke-WebRequest -Uri https://github.com/pamin-labs/orchestrator/releases/latest/download/orch-server-windows-x64.zip -OutFile orch.zip
Expand-Archive .\orch.zip -DestinationPath .
cd orch-server-*-windows-x64
.\orch-server.exe
```

The sandbox server is Linux-only — its egress mode is `nft` — so on Windows it
runs under WSL, next to the Docker Desktop daemon: `uvx opensandbox-server` in
there. Mount paths are translated for it, because a path this process writes as
`C:\orch\skills` is `/mnt/c/orch/skills` on its side, and the translated form is
what belongs in its `allowed_host_paths`. The `Sandbox server` pane prints the exact line.
</details>

It prints its own address on the way up. Loopback on purpose: there is no login
in front of the panel, so whoever reaches it is you — put a reverse proxy with
auth in front before publishing it anywhere else. `ORCH_HOST` and `ORCH_PORT`
move it; `config/default.yaml` is the same two settings for good.

The agent image is pulled by the sandbox server the first time it builds a
container — nothing to pull by hand.

<details><summary>From source instead</summary>

```bash
bun install --frozen-lockfile
bun start
```

Needs [`bun`](https://bun.sh). Same two lines above it for the sandbox server.

</details>

Then, once, in the panel:

1. **Sign in.** Both logins run the official CLI in a container — nothing is
   installed here. Pasting a token or an API key also works.
2. **Connect GitHub.** A device code. Note that **authorizing is not
   installing**: installing is where you pick which repositories it may touch,
   and until you do the repository list is empty. The panel says so when it
   spots that.
3. **Add a project** from the list. Nothing is copied here — a project is a
   GitHub coordinate. The first group clones it and works out your gates (test,
   typecheck, lint) by reading the repo; it writes the guess into project config
   where you can correct it.

## The team

- **Chief of Staff** — Works for you, not for a project. Batches every open question into one message. Blockers go straight through.
- **Dispatcher** — One sentence in, a plan out. Counts how many separate asks you actually typed, and splits the work into slices you accept one at a time.
- **Architect** — Standing, above every group. Assigns each group its own paths so two can't collide, then writes two lines on what's wrong with the plan — which you read before approving.
- **PM** — The group's one conversational entrance. You say something, one agent answers.
- **Engineer** — The only agent in a group that writes code. Serialised, so write conflicts don't exist.
- **QA** — Checks one slice against its acceptance criteria, from the diff and the test output — deliberately not from the whole repo.
- **Auditor** — Reviews the finished branch from outside the group, on a different model. Does it deliver what the card promised, did it reinvent something the codebase already has, do its own work notes match the real diff.
- **Scribe** — Writes the commit and the pull request, from the finished diff. Reads what was built, not what was planned, so the log says something a year later.
- **Librarian** — Keeps a project primer and a capped list of lessons learned, so a new agent starts already knowing the project.
- **Bootstrap** — Makes a fresh checkout buildable, working the install step out from the lockfile and CI config.

Adding a role is a YAML file, not code.

## How you know it isn't bluffing

Five things everyone who has used a coding agent has hit.

**"Done!" — and it isn't.**
A slice only counts once your project's own commands pass: test, typecheck,
lint. Exit codes decide, not the agent's summary. Failures go back to the
engineer, not to you. And you never get a percentage — the panel shows which
checks passed, because a number from an LLM is a guess.

**It reviewed its own work.**
Two reviews here, neither by the author. QA sees one slice's diff. The Auditor
sits outside the group, on a different model, and reads the whole branch.

**It said it changed A; it changed B.**
At the end of every slice the system compares what it claimed against what git
actually shows. Mismatches surface there, not while you're reading the PR.

**It knew the rules at turn 1 and forgot them by turn 20.**
So anything a check can catch is never left to a prompt: which files a group may
touch, how long a note may be, whether a stuck state has anyone to push it.
Prompts get forgotten. `if` doesn't.

**It wants you to approve a wall of text.**
The card that blocks you is capped at 12 lines; longer and it's sent back before
it reaches you. You approve a direction and its acceptance criteria, never an
implementation.

## What the sandbox stops — and what it doesn't

**It stops three things.**

- **Touching your computer.** An agent's container holds one clone of one
  project. Your other projects, your home directory, your working copy — it
  cannot reach any of them, because they are not in there.
- **Seeing your real tokens.** The container holds values that are the right
  shape and don't work. The real token is swapped in outside the container, at
  the moment the request leaves, so the container never sees it.
- **Pushing to your repository.** A group's GitHub credential is only good for
  fetching. Pushing happens in a separate container with no agent in it.

**It does not stop your data leaving.** The network is open by default, because
agents need to read docs and install packages. So credentials are safe, and
**your code can still be sent anywhere**. If that matters, fill in
`sandbox.denyDomains` before your first run.

**It does not isolate roles inside one group.** A group shares one container.
The boundary is between groups.

## Status

Early, and honest about it: **no requirement has been driven end to end yet.**
Not "not with real accounts" — no complete run of any kind. Every piece is
measured against the real thing on its own, and every stage is tested against a
stand-in on its own. Those are two kinds of evidence, and neither is the third.

Every bug so far came out of that gap, and all three looked identical:
**completely fine.** A directory reported that it mounted and was empty. A code
index rendered perfectly with its contents missing. Multi-line output from a
container arrived joined into one line, so everything reading it line by line
found nothing. None was caught by a test. All were found by measuring.

MIT licensed.

### Languages

<!-- i18n:table -->
**Panel** · 1116 messages

| Language | Progress | Messages |
| --- | --- | ---: |
| English | ![](https://progress-bar.xyz/100?width=140&suffix=%25) | source |
| 简体中文 | ![](https://progress-bar.xyz/100?width=140&suffix=%25) | 1116 / 1116 |
| 繁體中文 | ![](https://progress-bar.xyz/100?width=140&suffix=%25) | 1116 / 1116 |
| 日本語 | ![](https://progress-bar.xyz/100?width=140&suffix=%25) | 1116 / 1116 |
| 한국어 | ![](https://progress-bar.xyz/100?width=140&suffix=%25) | 1116 / 1116 |
| Español | ![](https://progress-bar.xyz/100?width=140&suffix=%25) | 1116 / 1116 |
| français | ![](https://progress-bar.xyz/100?width=140&suffix=%25) | 1116 / 1116 |
| Deutsch | ![](https://progress-bar.xyz/100?width=140&suffix=%25) | 1116 / 1116 |
| Português | ![](https://progress-bar.xyz/100?width=140&suffix=%25) | 1116 / 1116 |
| Русский | ![](https://progress-bar.xyz/100?width=140&suffix=%25) | 1116 / 1116 |

<!-- /i18n:table -->

## More

The [documentation index](docs/README.md) links the architecture, engineering
standards, operations, project state, and ADRs. Read [`AGENTS.md`](AGENTS.md)
before changing code and [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a
pull request. Security reports use the private process in
[`SECURITY.md`](SECURITY.md); support and project decisions are described in
[`SUPPORT.md`](SUPPORT.md) and [`GOVERNANCE.md`](GOVERNANCE.md).

`bun run check` runs the complete local quality gate. The project is MIT
licensed and follows the [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
The current owner and agent protocol roots are `/api/v1/*` and `/orch/v1/*`;
there are no unversioned compatibility aliases.

Built on [OpenSandbox](https://github.com/opensandbox-group/OpenSandbox). The agents
are the real `claude` and `codex` CLIs, not reimplementations of them.
