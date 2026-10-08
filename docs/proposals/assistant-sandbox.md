# ADR draft — Where the assistant runs a command

**Removed when:** the ADR recording the sandbox choice is accepted, as REQ-30 BC-11 requires
before the sandbox is built. The change that accepts it copies the decision into `docs/adr/` as
the next free number, which is `0012` on `dev` at `a14c3ab1c`, and deletes this file.

**Status:** proposed · **Date:** 2026-10-08 · **Requirement:** forge REQ-30 BC-11 (agreed, r1)

## Context

The owner asked on 2026-10-08 whether the assistant could have a sandbox to run commands in
when it needs one. REQ-30 BC-11, agreed the same day, now says:

> Can run commands when an answer needs them, inside an isolated sandbox: no host access, no
> project secrets, bounded time, CPU, memory and network, with the command and its output shown
> in the reply. The sandbox choice is recorded in an ADR before it is built.

What exists today:

- **Assistant mode** runs in core, in `packages/core/src/assistant/`. A turn is a loop over the
  configured chat provider, `run-turn-core.ts`, using Forge tools only. Two provider wires are
  registered by `packages/core/src/integrations/llm/bootstrap.ts:bootstrapChatProviders`. The
  Anthropic Messages wire goes over `@ai-sdk/anthropic` 4.0.72 and is preferred when it is
  configured. The OpenAI-compatible LiteLLM wire is the other.
- **Agent mode** runs a resident Claude Code session on a paired device that has the repository
  checked out and a full shell (`packages/runner/crates/runner-agent/src/chat.rs`). That session
  is bounded only by its residency. It is not sandboxed, and it runs as the device's user.
- **Core already starts a child process from a turn.**
  `packages/core/src/assistant/tools/forge-cli.ts:runForgeCli` runs the bundled `forge` CLI and
  passes it `{ ...process.env }`. The CLI is trusted code, so that is acceptable for the CLI. It
  also shows what a command run as a child of core would inherit: core's whole environment,
  including its database URL and provider keys. **No option below runs the command as a child of
  the core process.**
- **ADR 0009** says the runner is a thin box agent: it runs what core admits, and every decision
  belongs to core.

Three questions decide the choice:

1. **What does the assistant need to run?** There are two kinds of command.
   - **Computation over data the turn has already read**: counting, joining or charting
     issues, metrics or attachments; parsing a CSV or PDF; checking arithmetic before stating
     it (BC-1, BC-8). These need no repository and no network.
   - **Commands over the repository**: `git log`, `rg`, running a script. These need a
     checkout, and today only Agent mode has one.
2. **Where may the data go?** Anthropic already receives every chat turn. A new vendor would be a
   new processor of project data.
3. **Who operates it?** Core is a container on Coolify. A sandbox host is a second fleet to
   patch, size and watch.

## How others isolate command execution

| Product | Isolation | Network | Secrets | Source |
|---|---|---|---|---|
| Anthropic code execution tool | Anthropic-hosted container per `container.id`, 1 CPU, 5 GiB RAM, 5 GiB disk | **disabled** | the container never sees the caller's environment; files enter only through the Files API | [docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool) |
| Claude Code sandboxing | bubblewrap on Linux, Seatbelt on macOS; writes allowed only in the working directory | through a proxy outside the sandbox, with a domain allowlist | reads allowed by default, so secrets are protected by the deny list | [engineering post](https://www.anthropic.com/engineering/claude-code-sandboxing), [`sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime) (Apache-2.0) |
| OpenAI Codex CLI (Linux) | bubblewrap `--ro-bind / /` plus a seccomp network filter and `PR_SET_NO_NEW_PRIVS`; Landlock-only mode deprecated | `--unshare-net` unless routed through a managed proxy | `.git` and `.codex` re-bound read-only | [`codex-rs/linux-sandbox`](https://github.com/openai/codex/tree/main/codex-rs/linux-sandbox) |
| OpenAI Codex cloud | container per task | on during setup scripts, **off** while the agent works unless allowlisted; can be limited to GET, HEAD and OPTIONS | setup only | [internet access](https://learn.chatgpt.com/docs/cloud/internet-access) |
| Cursor cloud agents | one isolated VM per agent, defined by `.cursor/environment.json` (snapshot or Dockerfile) | outbound domains can be restricted | team-scoped, injected when the agent starts | [docs](https://cursor.com/docs/cloud-agent) |
| OpenHands | Docker container running an action execution server; local, Docker and remote runtimes | container networking | only what `SandboxConfig.volumes` mounts | [runtime docs](https://docs.openhands.dev/openhands/usage/architecture/runtime) |
| SWE-agent | SWE-ReX deployments: local, Docker, Modal, AWS Fargate | per deployment | per deployment | [SWE-ReX](https://github.com/SWE-agent/SWE-ReX) |
| Replit agent | Linux containers hardened with seccomp-bpf, being replaced by microVMs ("no shared kernel") | per repl | a sidecar injects authorization headers, so app code never holds the secret | [defense in depth](https://replit.com/blog/defense-in-depth-how-replit-secures-every-layer-of-the-vibe-coding-stack) |
| GitHub Copilot coding agent | GitHub Actions runner | firewall allowlist | pushes only to `copilot/` branches; workflows need approval | [risks and mitigations](https://docs.github.com/en/copilot/concepts/agents/coding-agent/risks-and-mitigations) |

The pattern is the same everywhere. **Hosted products use a VM or a hardened container and turn
the network off by default.** Tools that run on a person's own machine use bubblewrap or
Seatbelt with a proxy for egress. Several are moving from containers to microVMs, which is a
statement about how far a shared kernel is trusted.

## Options

| | (a) Anthropic code execution tool | (b) Hosted sandbox: E2B, Modal, Daytona | (c) Self-hosted container per turn: gVisor or Firecracker | (d) Runner `exec` job: bubblewrap/nsjail or rootless container |
|---|---|---|---|---|
| **Isolation** | Anthropic's container; nothing shared with core | E2B and Daytona: Firecracker microVM. Modal: gVisor, with an optional VM runtime | runsc is a user-space kernel; Firecracker is a KVM microVM with a jailer | shared kernel, user namespaces, seccomp; the weakest of the four |
| **Network** | disabled, and cannot be turned on | E2B: per-sandbox firewall. Modal: `block_network`, `outbound_cidr_allowlist`, `outbound_domain_allowlist` (beta) | whatever we build | `--unshare-net` (measured: no DNS); an allowlist needs a proxy, as sandbox-runtime does |
| **Limits** | 1 CPU, 5 GiB RAM, 5 GiB disk, fixed. Python cells time out at 90 s on `code_execution_20260521` | configurable. E2B default is 2 vCPU and 4 GiB; sessions last up to 1 h on Hobby and 24 h on Pro | configurable | cgroups through a `systemd-run` scope (measured), or nsjail's own cgroups and rlimits |
| **What it could run** | bash, Python 3.11 and file operations over files core uploads. No repository unless core uploads a snapshot. No `pip install` | anything in the image. A repository needs a clone, which needs network or an upload | anything in the image; a shallow clone made by core outside the sandbox and mounted read-only | the device's existing checkout, exported read-only at a pinned sha; the device's toolchain |
| **Cold start** | in-band on the first call; a container idle about 5 min is checkpointed and restored on reuse. Not measured here | E2B about 150 ms (vendor figure, not verified). Daytona under 90 ms (README claim) | Firecracker ≤ 125 ms to guest init ([SPECIFICATION.md](https://github.com/firecracker-microvm/firecracker/blob/main/SPECIFICATION.md)); runsc container start in seconds, not measured | **29 ms** for `bwrap --unshare-all --clearenv`, measured on this runner box |
| **Price** | 1,550 free container-hours per organization per month, then $0.05 per container-hour, 5 min minimum. **Free** when the request also offers `web_search_20260209` or `web_fetch_20260209` or later ([pricing](https://platform.claude.com/docs/en/about-claude/pricing)) | E2B: $0.000014 per vCPU-s plus $0.0000045 per GiB-s, about $0.12 an hour for 2 vCPU and 4 GiB ([pricing](https://e2b.dev/pricing)). Modal: not verified | a host, plus engineering to build and run a sandbox service | no marginal cost; the device is already paid for |
| **Ops burden** | none | one vendor account and one API key held by core; self-host is possible ([`e2b-dev/infra`](https://github.com/e2b-dev/infra), Apache-2.0) | high: core cannot start containers without the Docker socket, which is root on the host, so this needs a separate sandbox service, a host with KVM for Firecracker, image builds and kernel patching | a new job kind in core and a Linux and macOS wrapper in the runner; Windows has none |
| **Data leaves to** | Anthropic, which already receives every turn. **Not ZDR-eligible**; uploaded files persist until deleted | a new processor | nowhere | nowhere: the repository is already on the device |
| **Availability** | only on the Anthropic wire, and only on Anthropic's API, Claude Platform on AWS or Microsoft Foundry. Not on Bedrock or Vertex, and not through the LiteLLM wire | always, while the vendor is up | always, while the host is up | only while a paired device for the project is online |
| **Fit with ADR 0009** | nothing on the box; core decides and the model provider executes | nothing on the box | nothing on the box; core owns a fleet | the box runs what core admits and bounds, which is what ADR 0009 says the runner is for |

**Daytona is out.** Its public repository is now read-only, and its development has moved to
private code (README, read 2026-10-08). The AGPL-3.0 licence and the prices quoted for it come
from secondary sources only.

## Decision (proposed)

**Use (a), Anthropic's server-side code execution tool, for Assistant mode now. Add (d), a
sandboxed `exec` job on the runner, only when commands need the repository. Do not build (c).
Keep (b) as the named fallback** for a project that refuses (a), either because it needs ZDR or
because it runs on the LiteLLM wire.

Reasons:

- (a) meets every clause of BC-11 without new infrastructure:
  - **no host access:** the container is not on any Forge host;
  - **no project secrets:** core's environment never enters it;
  - **bounded time, CPU and memory:** fixed by Anthropic, and capped further per turn by core;
  - **network:** off;
  - **cost:** at Forge's volume, about zero. 1,550 hours is 18,600 five-minute minimums a month,
    and the tool is free outright when web search or web fetch is offered in the same request.
- (d) is the only option that reaches the repository without copying it off the box. It fits
  ADR 0009: core decides whether the command runs and with what limits, and the box runs it and
  reports. Its isolation is the weakest of the four, and it runs on the owner's machines. So it
  waits until the computation-only phase shows that repository commands are actually asked for.
- (c) would need core to hold the Docker socket, which is root on the host, or a second fleet.
  Both cost more than the risk they remove, given that (a) exists.

## Phased plan

**Phase 1: computation in Assistant mode, with option (a).**

1. **Provider events.** `packages/core/src/integrations/llm/ai-sdk.ts:bridgeStream` carries a
   provider-executed tool call and its result as their own events. Today it maps every
   `tool-call` part to a client `tool_call`, which `run-turn-core.ts` would then try to execute.
   It also drops every `tool-result` part.
2. **Storage and display.** The transcript stores the command, its exit code, a capped stdout and
   stderr, and any files produced. The reply shows the command and its output (BC-11).
3. **Offering the tool.** It is offered only when the resolved provider is `anthropic` and
   `ANTHROPIC_API_URL` points at Anthropic itself. On any other wire, a request that needs it is
   refused by name ("commands need the Anthropic provider; this project answers through
   LiteLLM"). It never falls back to running the command anywhere else.
4. **Tool version.** Pin `code_execution_20260120`, the newest version `@ai-sdk/anthropic` 4.0.72
   exposes. Moving to `20260521`, which adds the 90 s cell limit to the tool description, needs a
   package upgrade.
5. **Containers.** Use one container per conversation, keyed by `container.id`. Never reuse one
   across conversations, projects or people. Expire it with the conversation.
6. **Inputs.** The only inputs are files the turn's own tools have already read under the asker's
   permissions (BC-10), passed through `@forge/observability`'s `scrubSecretsDeep` before
   `container_upload`. Uploaded files are deleted through the Files API when the turn ends.
7. **Limits per turn.** Core enforces at most 8 executions per turn and 120 s of execution wall
   time per turn. Hitting either is reported as a stop, with which limit was hit (BC-9).
8. **Permission.** Running a command is a permission, `assistant.exec`, per ADR 0007. External
   chat doors do not hold it.

**Phase 2: repository commands, with option (d), if Phase 1 shows they are asked for.**

1. **Job kind.** Add an `exec` job kind. Core admits it, picks the device and sets the limits: a
   wall clock, CPU quota, memory, task count and output cap. The runner wraps the command and
   reports its exit code and output. It decides nothing.
2. **Linux wrapper.** Run under `systemd-run --scope` with `MemoryMax`, `MemorySwapMax=0`,
   `CPUQuota`, `TasksMax` and `RuntimeMaxSec`, around
   `bwrap --unshare-all --clearenv --die-with-parent`. Bind read-only only `/usr` and a
   `git archive` export of the pinned sha. **Never bind `.git`**: its config can carry a token in a
   remote URL. Never bind `$HOME`, the runner's sockets, `~/.claude` or an ssh-agent socket. Leave
   out network.
3. **macOS.** Use Seatbelt with an equivalent deny-by-default profile.
4. **Windows.** Refuse by name until there is a wrapper.
5. **Reuse.** Prefer `@anthropic-ai/sandbox-runtime`'s profile shapes to a profile we write
   ourselves. The runner is Rust, so it reuses the profiles rather than the npm library.
6. **Mode boundary.** This changes BC-2: Assistant mode reaching the repository. That boundary
   needs a revision of REQ-30 before it is built.

**Fallback: option (b), E2B.** It has the same shape as (a), with network off and files uploaded.
It is for a project that sets "no ZDR-ineligible processing" or runs on the LiteLLM wire.
Self-hosting E2B on KVM is the exit if the vendor becomes the problem.

## Threat model

| Threat | Path | Phase 1, (a) | Phase 2, (d) |
|---|---|---|---|
| **Prompt injection runs a command** | an issue body, feedback from an external person, an attachment or a repository file tells the model to run something | The sandbox holds only what the asker could already read and reaches nothing, so an injected command can compute but cannot act. The command is shown in the reply. Sandbox output returns as untrusted tool output: it passes the reply check (BC-8), and it cannot write to Forge without the person's confirmation (BC-4) | Same, plus: the command runs on the owner's device. Every bind is read-only, nothing is mounted beyond `/usr` and the exported tree, and there is no network |
| **Data exfiltration** | a command sends data somewhere other than the reply | No network, so the reply is the only channel, and it goes to people who may read the data. In a room with several people, uploads are limited to what **every** member may read | `--unshare-net`; no sockets bound in |
| **Secrets** | the command reads a key, token or credential | The container never receives core's environment. Uploads are scrubbed. The turn credential (`packages/core/src/credentials/turn-credential.ts`) is never uploaded | `--clearenv`; no `$HOME`, `.git`, `~/.claude`, runner `control.sock` or `tmux.sock`, Docker socket or ssh-agent |
| **Network egress** | downloading a payload, calling an API, using DNS to tunnel data out | Disabled by Anthropic and cannot be enabled | Off. An allowlist would need a proxy and a new criterion |
| **Resource exhaustion and cost** | a fork bomb, a memory spike, an endless loop, many executions | Fixed at 1 CPU and 5 GiB per container, plus per-turn caps in core | cgroup scope. Measured: a 400 MB allocation under `MemoryMax=128M` was killed in 0.59 s |
| **Sandbox escape** | a kernel or runtime bug | Anthropic's boundary | A user-namespace kernel bug on the owner's box. This is the residual risk that keeps (d) out of Phase 1. This box restricts unprivileged user namespaces through AppArmor (`kernel.apparmor_restrict_unprivileged_userns=1`), and bwrap runs under its `bwrap-userns-restrict` profile |
| **Cross-tenant leakage** | a container reused by another conversation or person | One container per conversation, never shared | A fresh namespace per command, with nothing persisted |
| **Retention** | uploaded data outlives the conversation | Files are deleted after the turn and containers expire. **Not ZDR-eligible**, which is stated to the owner and not hidden | Nothing persists |

## Limits

- **Phase 1:**
  - no repository;
  - no network, so no `pip install`; the preinstalled Python 3.11 libraries and CLI tools only;
  - 1 CPU;
  - nothing that needs Forge's own API from inside the sandbox, by design;
  - unavailable on the LiteLLM wire, on Bedrock and Vertex, and for a project that requires ZDR.
- **Phase 2:**
  - only while one of the project's devices is online;
  - Linux and macOS only;
  - the device's toolchain, not a pinned image.
- **Both phases** are for answering a question. They are not Agent mode: no writes to the
  repository, no commits and no long-running processes.

## Honest costs

- **Provider lock-in for the capability:** running commands works only on the Anthropic wire.
  A project on LiteLLM gets a refusal by name until the E2B fallback is built, which is a second
  implementation of the same tool.
- **Not ZDR-eligible:** files uploaded to the container are kept by Anthropic until core deletes
  them, and the container until it expires. A project with a zero-retention obligation cannot turn
  this on.
- **Core changes before anything is visible:** Phase 1 has to change the provider bridge
  (`bridgeStream`), the transcript shape, the reply view and the per-turn caps. The tool itself
  is free, but this is not a one-line change.
- **Pinned to the SDK's tool version:** `@ai-sdk/anthropic` 4.0.72 stops at
  `code_execution_20260120`, so the newest tool version waits on a package upgrade.
- **Phase 2 trusts a shared kernel on the owner's machines:** a user-namespace escape there
  reaches a box that holds device credentials. Waiting until demand is shown is part of the price.
- **Phase 2 changes a mode boundary:** Assistant mode reaching the repository blurs BC-2's line
  between the two modes, and a requirement revision has to be agreed first.
- **Rejecting (c) gives up the strongest self-owned isolation:** Forge will not own a microVM
  fleet. If both Anthropic and E2B became unacceptable, the work for (c) starts from nothing.

## What REQ-30 does not yet say that this needs

BC-11 states the boundary. The recommendation also depends on the following, and none of it is
in REQ-30 r1:

1. **Inputs:** the sandbox receives only data the asker may read (and, in a shared room, data
   every member may read), scrubbed of secrets before upload. BC-10 covers reads, not what is
   copied into a sandbox.
2. **Retention and reuse:** uploads are deleted after the turn, and a sandbox is never reused
   across conversations, people or projects.
3. **Network:** BC-11 says "bounded network". This proposal means none. Whether an egress
   allowlist, such as package registries, is ever allowed is an owner decision.
4. **Provider dependency:** when the configured provider cannot run the sandbox, the reply says
   so by name. BC-9 lists other failures, not this one.
5. **Per-turn and per-project budget:** a cap on executions and wall time per turn, and a monthly
   cap per project, each reported as a stop when hit.
6. **Permission:** who may make the assistant run a command (`assistant.exec`), and that external
   chat doors may not.
7. **Execution record:** every command, its exit code, duration and the limit that stopped it,
   recorded on the session page next to the refusals that BC-8 already lists.
8. **Untrusted output:** command output never drives a write without BC-4's confirmation, and a
   figure taken from it is cited as coming from the command (BC-1).
9. **Repository access in Assistant mode (Phase 2 only):** BC-2 gives the repository to Agent mode
   alone, so Phase 2 needs BC-2 revised.
10. **Opt-out:** a project that requires ZDR or forbids third-party processing can turn the
    sandbox off.

## Evidence

Measured on 2026-10-08:

- **Runner box (Linux, KVM present; Docker with runc only; no runsc, nsjail or firecracker
  installed):**
  - `bwrap --ro-bind /usr /usr --proc /proc --dev /dev --tmpfs /tmp --unshare-all --clearenv`
    started in 0.029 s;
  - inside it, the root held only `bin dev lib lib64 proc tmp usr`, `/home` did not exist, the
    environment held one variable, and DNS failed;
  - under `systemd-run --user --scope -p MemoryMax=128M -p MemorySwapMax=0`, a 400 MB Python
    allocation was killed (exit 143).
- **`@ai-sdk/anthropic` 4.0.72** (`packages/core/package.json`): its bundle names
  `code_execution_20250522`, `20250825` and `20260120`, and not `20260521`.
- **Web sources** were read on 2026-10-08 at the URLs in the tables above.
- **Not verified here:**
  - E2B's cold-start time;
  - Modal's prices;
  - the code execution tool's container-creation latency;
  - whether the core host on Coolify exposes KVM.
