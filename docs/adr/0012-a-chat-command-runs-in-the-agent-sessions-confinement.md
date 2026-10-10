# 0012 — A chat command runs inside the Agent session's confinement on the runner

**Status:** accepted · **Date:** 2026-10-10

## Context

REQ-30 BC-11 asks that the chat run a command when an answer needs one, inside an isolated sandbox:
no host access, no project secrets, bounded time, CPU, memory and network, with the command and its
output shown. It asks for the sandbox choice to be recorded before it is built.

Three places could run that command:

- **A provider's code-execution container.** The owner ruled it out on 2026-10-09: no direct
  provider key and no provider-only server tools; models are reached only through the gateway.
- **A sandbox inside core.** Core already runs short scripts in a QuickJS-wasm isolate
  (`packages/core/src/sandbox/`), which reads Forge only by GET under the asker's token. It has no
  shell, no repository and no package tools, so it answers a question about Forge's own records, not
  one that needs a command.
- **The Agent session on the paired runner.** It already holds the checkout and a shell, and every
  confined chat session already runs under bubblewrap (`Sandbox::command` in
  `packages/runner/crates/runner-platform/src/confine.rs`).

## Decision

**A command a chat answer needs runs in Agent mode, inside the confined session on the runner.**
Assistant mode runs none; a question that needs one is told to use Agent mode.

The confinement is the sandbox, and it bounds each axis BC-11 names:

- **Host access:** a mount namespace binds the whole tree read-only and empties the home, temp and
  runtime trees; only the checkout and the session's own Claude config are writable
  (`chat_sandbox` in `packages/runner/crates/runner-agent/src/claude_code/confine.rs`). A PID
  namespace hides every other process.
- **Secrets:** the environment holds only the variables named, and the session's credential is a
  turn token minted for the asker; the box's PAT, device token, SSH keys and CLI accounts are not in
  view.
- **Network:** a network namespace with one way out, the egress proxy, which reaches only the
  model and Forge hosts it was started with (`packages/runner/crates/runner-platform/src/confine/egress.rs`).
- **CPU, memory and file size:** `packages/runner/crates/runner-platform/src/confine.rs:LIMITS` sets `RLIMIT_CPU`, `RLIMIT_DATA` and
  `RLIMIT_FSIZE` on the sandbox before bubblewrap execs, inherited by every command inside.
- **Time:** core's turn timeouts end the turn and the runner kills the session's process group.
- **Shown:** the Agent door's prompt asks for the command and the output the answer rests on.

## Consequences

- No new execution service exists to run, patch or pay for. The cost is that a command needs a
  paired Linux box with bubblewrap; elsewhere the box declares it cannot confine and core refuses
  the turn by name instead of running it unconfined.
- The ceilings are generous by design (two CPU hours per process, 16 GiB of data, 4 GiB per file):
  they stop a runaway command from taking the box, not a real session's work. Tightening them is a
  change to `LIMITS` and to this record.
- The core QuickJS sandbox stays for what it is: scripts over Forge's own records (REQ-32 BC-16,
  REQ-37), never a shell.
