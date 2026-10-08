# ADR draft — Where the assistant runs a command

**Removed when:** the ADR recording the sandbox choice is accepted, as REQ-30 BC-11 requires
before the sandbox is built. The change that accepts it copies the decision into `docs/adr/` as
the next free number, which is `0012` on `dev` at `a14c3ab1c`, and deletes this file.

**Status:** proposed; decided by owner ruling 2026-10-09 · **Date:** 2026-10-08 · **Requirement:** forge REQ-30 BC-11 (agreed, r1), built as REQ-32 BC-14

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

## Decision

**Owner ruling, 2026-10-09: use (d), a sandbox on the team's own runner, for computation now. (a)
is ruled out, and so is any Claude code-execution API or direct provider key: models are reached
only through the configured gateway (`ANTHROPIC_API_URL` / `LITELLM_API_URL`), and execution
stays on the team's runners. (b) and (c) are not built.**

Reasons:

- (d) meets BC-11 with nothing new to operate: the runner is already paired, already confines a
  chat session with bubblewrap, and already takes asks from core over its socket.
- The data stays with the team: it goes to a box the team paired with the project, never to a
  third party, so a project that forbids third-party processing or requires ZDR can still turn it
  on.
- It fits ADR 0009: core picks the box, sets the limits and reads the output; the box runs it.

## Phased plan

**Phase 1: computation in Assistant mode, with option (d), built (REQ-32 BC-14).** The
`runner-sandbox` adapter of the reports Executor port
(`packages/core/src/runners/compute-sandbox.ts`), registered on every deployment:

1. **Box.** Core hands a computation to a box bound to the project that is connected, not turned
   off or draining, and whose heartbeat declares `computeSandbox` with the language's interpreter
   (`computeSandboxLanguages`). Where none can, the computation is refused
   `EXECUTOR_UNAVAILABLE` naming each box's reason (none paired, not connected, cannot confine
   and why, a runner too old, no interpreter), and no frame is sent.
2. **Channel.** The ask-a-box exchange the checkout reads use: a `compute.run` frame on the box's
   socket, never kept for a replay, and the answer on `POST /api/devices/me/compute-runs/:id`.
3. **Sandbox** (`packages/runner/crates/runner-platform/src/confine/compute.rs`): bubblewrap with
   the system read-only, the user's home, `/home`, `/root`, `/tmp`, `/var`, `/run` and the XDG
   trees emptied, a throwaway working directory holding only the script and `inputs.json`, a
   network namespace with only loopback, and an environment built from a list. Caps through
   `ulimit`: address space (`memoryMb`), CPU time (`cpu` cores for the wall limit), file size;
   the wall limit kills the process group. The output file is read without following a link and
   the directory is removed.
4. **Output.** The box returns `frames.json` or `frames.csv` as text and its capped logs; core
   reads the frames (`framesFromOutput`), keeps the execution record and shows the script and its
   result (BC-11).
5. **Limits per turn.** Core enforces at most 8 executions per turn and 120 s of execution wall
   time per turn. Hitting either is reported as a stop, with which limit was hit (BC-9).
6. **Permission.** Running a command is a permission, `assistant.exec`, per ADR 0007. External
   chat doors do not hold it.

**Phase 2: repository commands, also on the runner, if Phase 1 shows they are asked for.**

1. **Checkout.** Bind a `git archive` export of a pinned sha read-only. **Never bind `.git`**: its
   config can carry a token in a remote URL.
2. **macOS.** Seatbelt with an equivalent deny-by-default profile; Windows refuses by name.
3. **cgroups.** Move the caps from `ulimit` to a `systemd-run --scope` with `MemoryMax`,
   `CPUQuota` and `TasksMax` where the box allows it.
4. **Mode boundary.** This changes BC-2: Assistant mode reaching the repository. That boundary
   needs a revision of REQ-30 before it is built.

## Threat model

| Threat | Path | Phase 1, (d) as built |
|---|---|---|
| **Prompt injection runs a command** | an issue body, feedback from an external person, an attachment or a repository file tells the model to run something | The sandbox holds only what the asker could already read and reaches nothing, so an injected command can compute but cannot act. The command is shown in the reply. Its output returns as untrusted tool output: it passes the reply check (BC-8), and it cannot write to Forge without the person's confirmation (BC-4) |
| **Data exfiltration** | a command sends data somewhere other than the reply | A network namespace with only loopback: no DNS, no route, not even the box's own loopback services. The reply is the only channel |
| **Secrets** | the command reads a key, token or credential | The environment is built from a list; the home, `/home`, `/root`, temp and runtime trees are empty, so the runner's credentials, checkouts, `.git`, `~/.claude`, sockets and ssh-agent are not in view. Inputs are scrubbed before they leave core |
| **Network egress** | downloading a payload, calling an API, using DNS to tunnel data out | Off |
| **Resource exhaustion** | a memory spike, an endless loop, a huge file, many executions | `ulimit` caps on address space, CPU time and file size, the wall limit killing the process group, and per-turn caps in core. No task cap yet: a fork bomb is bounded only by the wall limit |
| **Sandbox escape** | a kernel or runtime bug | A user-namespace kernel bug on the team's box. This box restricts unprivileged user namespaces through AppArmor (`kernel.apparmor_restrict_unprivileged_userns=1`), and bwrap runs under its `bwrap-userns-restrict` profile |
| **Cross-tenant leakage** | state reused by another conversation or person | A fresh namespace and working directory per execution, removed after it |
| **Retention** | data outlives the execution | The working directory is removed; only core's execution record is kept, for the record's keep |

## Limits

- no repository;
- no network, so no `pip install`; the box's own `python3` and `bash` only;
- only while a paired Linux box with bubblewrap is connected;
- nothing that needs Forge's own API from inside the sandbox, by design;
- for answering a question: no writes to the repository, no commits and no long-running
  processes.

## Honest costs

- **Availability follows the team's boxes:** with no Linux box with bubblewrap connected, every
  computation is refused by name.
- **The box's interpreter, not a pinned image:** a script sees whatever `python3` and libraries
  the box has.
- **A shared kernel on the team's machine:** a user-namespace escape reaches a box that holds
  device credentials.
- **No task cap:** `ulimit -u` counts every process of the box's user, so it is not set; the wall
  limit is the bound on a fork bomb until Phase 2's cgroups.

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
4. **Runner dependency:** when no box of the team can run the sandbox, the reply says so by
   name. BC-9 lists other failures, not this one.
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
