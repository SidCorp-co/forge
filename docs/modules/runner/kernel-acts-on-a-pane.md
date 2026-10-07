# Which door serves each kernel act on a pane

A pane is a Claude Code session the runner starts: a project's master, or a job. Two installers
put hooks into it. The runner writes its own into the checkout's local Claude Code settings file
(`packages/runner/crates/runner-workspace/src/hook_install.rs:merged_for`). The forge-plugin, which
the runner installs at user scope (`packages/runner/crates/runner-workspace/src/plugin_sync.rs:ensure_plugins`),
adds its own hooks and puts the plugin `forge` CLI on PATH. Nothing in the runner turns the
plugin's hooks off: `packages/runner/crates/runner-workspace/src/hook_install.rs:take_ours_out` removes only the runner's own entries before
it writes them again.

On dev, masters and runs do not use plugin verbs (owner ruling of 2026-10-07, FB-89). A kernel act
that only the plugin serves is therefore one dev does not have. Read this table against the code
it cites. Where the two disagree, the code is right.

| Act | Door on a dev pane | Without the plugin |
|---|---|---|
| Reading the tracker and writing to it | `forge-runner api <path>` with the pane's credential (`packages/runner/crates/forge-runner/src/cmd/api.rs:rest_client`) | served |
| Attaching evidence | `forge-runner api issues/<id>/attachments -F file=@<path>`, which sends multipart (`packages/runner/crates/runner-transport/src/api/form.rs:encode`) | served |
| The method a run or a wave follows | core's guides, read with `forge-runner api guides/issue-flow.md` and `forge-runner api guides/dispatch.md` | served |
| Declaring a run | `forge-runner run declare` to the daemon's control socket (`packages/runner/crates/forge-runner/src/cmd/run.rs:run`) | served |
| The run brief | `forge-runner run brief <run id>` (`packages/runner/crates/forge-runner/src/cmd/run/brief.rs:brief`): base branch from the project, held trees read with git against `origin/<baseBranch>` | served |
| Dispatch gate: a shipped role dispatched with nothing declared is refused | the runner's `PreToolUse` hook, `forge-runner gate` (`packages/runner/crates/forge-runner/src/cmd/gate.rs:answer`, deciding in `packages/runner/crates/runner-core/src/dispatch_gate.rs:decide`) | served |
| Holding the issue | the run session the box opens for a declared run (`packages/runner/crates/runner-transport/src/run_sessions.rs:beat`); core refuses `in_progress` with no holder (`NO_HOLDER`) | served |
| Heartbeat | `packages/runner/crates/runner-transport/src/heartbeat.rs` | served |
| Turn, subagent and transcript reports | the runner's `UserPromptSubmit`, `Stop`, `SubagentStart`, `SubagentStop`, `StopFailure`, `TeammateIdle` and `PostCompact` hooks, `forge-runner hook` (`packages/runner/crates/forge-runner/src/cmd/hook.rs:run`). They report; `SubagentStop` also answers the stop gate below, and a stop it refuses is not reported. | served |
| Permission dialogs | the runner's `PermissionRequest` hook denies the dialog and says how to rephrase (`packages/runner/crates/forge-runner/src/cmd/hook.rs:answer`) | served |
| A question for a person | `forge-runner question` (`packages/runner/crates/forge-runner/src/cmd/question.rs`) | served |
| **Stop gate**: refuse a run's stop while it holds an `in_progress` issue with nothing written since it took it, while its worktree is dirty, or while a process it started still stands in its worktree | the runner's `SubagentStop` hook, `forge-runner hook` (`packages/runner/crates/forge-runner/src/cmd/hook/stop.rs:gate`, deciding in `packages/runner/crates/runner-core/src/stop_gate.rs:decide`). It finds the run in the box's ledger by the subagent's id, and reads the issue and its activity from core, the worktree from git, and the processes from `/proc`. Each refusal names `STOP_HELD_UNWRITTEN`, `STOP_WORKTREE_DIRTY` or `STOP_PROCESS_RUNNING`. A reading it cannot make refuses nothing. After three refusals in a row the next stop is let through. Every judged stop is written to `stop-gate.jsonl` in the runner's config directory. A pane's own `Stop` is its master's turn, and is not judged. While the plugin is installed, its `turn/stop-check` also runs. | served |
| Learning gate: a session must record a learning before it ends | nothing, on either side. The plugin's `learning-gate` does the opposite: it pauses before a memory write. | not served, with or without the plugin |

The plugin's other hooks are project policy, not kernel acts. They are: the destructive-shell
guard, the codex review holds, plan scope, the owed-restart pause, CLAUDE.md claims, case lists,
code quality, the owner-precedent answers, and unread-comment delivery before an issue write.
A dev pane keeps them only while the plugin is installed. Its `brief` dispatch check also
requires a brief printed by the plugin's own `forge brief` in the last ten minutes. That check
is not a kernel act: on dev the brief comes from `forge-runner run brief`, and the declaration
gate above is what refuses a dispatch.

No kernel act on a pane is now served by the plugin alone. Nothing yet shows the whole set
holding with the plugin absent: no run has gone from `open` to `awaiting_release` on dev with the
pane's plugin CLI and hooks unavailable (ISS-299).
