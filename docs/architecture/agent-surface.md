# The agent's surface: two CLIs, one shrinking MCP

How an agent reaches core, which CLI belongs to whom, and which MCP tools survive.
**Verified against the tree and the live tracker DB 2026-09-06, after `ISS-508`, `ISS-927` and
`ISS-931` all merged. The tool groups below were re-measured the same day against the
`forge-plugin` copy installed on a runner box — the fleet artifact, which this repo cannot see —
and three tools moved out of "free to go" as a result.**

## Today

```mermaid
flowchart LR
  subgraph BOX["runner box"]
    D["forge-runner<br/>Rust daemon"]
    subgraph S["agent session"]
      SK["SKILLS"] --> CLI["CLI · bin/forge<br/>21 verbs"]
      HK["HOOKS"] --> CLI
      MC["Claude's MCP client<br/>.mcp.json"]
    end
    D -->|spawns| S
    D -->|"writes .mcp.json<br/>JOB token"| MC
  end

  subgraph CORE["forge · core"]
    API["API · REST /api/*"]
    MCP["MCP · /mcp<br/>59 tools"]
    WS["WS · /ws"]
  end

  D -->|"WS · device token"| WS
  D -->|"forge-runner api · $FORGE_PAT"| API
  CLI -->|"REST · $FORGE_PAT<br/>3.35.141+"| API
  CLI -->|"jsonrpc tools/call · 9 tools<br/>3.35.140, what the fleet runs"| MCP
  CLI -.->|"uploads · step_start<br/>either version"| MCP
  MC -->|"jsonrpc tools/call · job token"| MCP
```

Two CLI arrows because two copies are live: the one `ISS-508` shipped and the one the boxes still
run. The nine tools the second arrow carries cannot go while it exists — that is the fleet-upgrade
row in the table below, drawn rather than only stated. **That arrow survives `ISS-931`**: the CLI
authenticates with a `forge_pat_*`, not a device token, so `requirePat` accepts it. It is the one
population a deletion can still strand.

Two command-line surfaces reach the same data plane:

| | Built in | Transport | For |
|---|---|---|---|
| `forge-runner api` | this repo | REST, `$FORGE_PAT` | **the runner's own work.** It must never depend on the plugin — a daemon that cannot reach core until a Claude Code plugin is installed is a worse daemon |
| `forge` | [forge-plugin](https://github.com/SidCorp-co/forge-plugin) | REST, `$FORGE_PAT` | **the agent.** Skills call its verbs; it is the agent's whole surface |

The plugin was the spine until `ISS-508` closed on 2026-09-06: every `forge` verb now goes to a
path under `/api`, keyed by a declared route table in `src/tracker/rest.mjs`, except the two that
route through `forge_uploads` and `forge_step_start` — which stay on `/mcp` by design, not by lag. **The fleet has not caught up** — the copy installed on `forge-vm` is
3.35.140 and still carries `src/tracker/rpc.mjs`, so the seven families that copy names are held
by a version upgrade, not by a decision.

**No device authenticates `/mcp` any more.** `requirePat` takes one species — `forge_pat_*` — and
refuses every other bearer with a 401 naming the class and the remedy
(`packages/core/src/middleware/require-pat.ts`). `forge-runner` writes each job's `.mcp.json` with
that job's own token, the same credential the spawn exports as `$FORGE_PAT`
(`packages/runner/crates/forge-runner-core/src/mcp/config.rs`). What the device token still holds:
`/ws`, and the REST routes behind `requireDevice` — chiefly the pool a master claims from.

**This ships on two clocks and the second one is a binary.** Core refuses the device at deploy; a
box only starts writing the job token when it installs a `forge-runner` that does. In between,
`claude`'s MCP client on an un-upgraded box gets 401 on every call, which is why the refusal says
*"needs a newer forge-runner binary"* rather than anything about PATs. The fleet when this landed:
three boxes, all `0.12.0`, all online; every other `devices` row `revoked`/`offline`. Device MCP
traffic in the 24h before: 1,565 calls against 82,722 on tokens.

Two reachability changes come with it, and neither is a bug to file:

- **Admin-gated tools need the `admin` scope, which no machine token carries.** A paired device had
  no scopes at all, so `assertPrincipalIsAdmin`'s scope half was skipped for it and only the
  project role was asked. A `job:`/`session:` token is minted `['read','write']`
  (`jobs/job-token.ts`, `agent-sessions/session-token.ts`), so `forge_skills.register` /
  `.create` / `.update` / `.delete` / `.adopt` / `.push`, `forge_runners` register / retire /
  update_capabilities, `forge_config action=update`, `forge_schedules` create / update / delete /
  run and `forge_reconcile` now answer `FORBIDDEN: this token lacks the admin scope` to a pipeline
  agent. That traffic was operator-shaped and mostly dormant (`forge_skills.register` last
  2026-08-07, `.adopt` 08-09, `runners register` 08-12, `reconcile` 08-10); `forge_config
  action=update` and `forge_skills.update` were live, and both already had succeeding token
  callers. An operator who wants one of these from an agent mints a PAT with `admin` and sets it as
  the box's `$FORGE_PAT` — deliberately an operator decision, because the alternative is ambient
  admin authority, which is what `ISS-927` removed from REST.
- **A non-member now reads as not-found, not forbidden.** `assertDeviceOwnerIsMember` answered
  `FORBIDDEN: device owner is not a member`; `assertPrincipalIsMember` answers
  `NOT_FOUND: project not found or not accessible`, the existence-hiding semantics the rest of the
  surface already used. Fourteen tools moved onto it, and the move also closed what `ISS-150`'s
  review called blocker #1: the device helpers read only `ownerId`, so those fourteen never
  consulted the token's `projectIds` allowlist.

## Target

```mermaid
flowchart LR
  subgraph BOX["runner box"]
    D["forge-runner"]
    subgraph S["agent session"]
      SK["SKILLS<br/>shape of the procedure"] --> CLI["CLI · bin/forge"]
      HK["HOOKS"] --> CLI
    end
    D -->|spawns| S
  end

  subgraph CORE["forge · core"]
    API["API · REST /api/*<br/>the one data contract"]
    MCP["MCP · /mcp<br/>step_start · uploads"]
    WS["WS · /ws"]
  end

  D -->|"WS · device token"| WS
  D -->|"forge-runner api"| API
  CLI -->|"REST · $FORGE_PAT"| API
  CLI -.->|"2 tools"| MCP
```

**One arrow changes port.** The CLI leaves `/mcp` for `/api`, and `/mcp` keeps only what cannot be
served to a shell, plus the clients that have no plugin — desktop chat and third parties.

Skills keep the **shape** of a procedure; core keeps each project's **answer** to it. Neither knows
the other's half, which is why a skill never names `runner-v*` or any project's command.

## Which tools stay

| Group | Tools | Why |
|---|---|---|
| **stay** | `forge_step_start`, `forge_uploads` | `step_start` opens the session every other call reports into and returns the issue body the runner did not inline; `uploads` returns an image content block, which a shell process cannot produce |
| **blocked on a fleet upgrade** | `forge_issues` `forge_comments` `forge_config` `forge_guide` `forge_knowledge` `forge_memory.search` `forge_project_pm` `forge_projects.get` `forge_projects.list` | the 9 the pre-`ISS-508` plugin CLI calls — counted by grepping the installed artifact, not this repo, because this repo cannot see it. That CLI has moved to `/api`; the copies running on the boxes have not. Deleting one before the fleet upgrades breaks those copies, and this CLI holds a PAT, so `ISS-931` did not take its access away |
| ~~blocked on the runner's `.mcp.json`~~ **cleared** | ~20 that took device-token calls | `ISS-931` closed it: `/mcp` refuses a device and `mcp/config.rs` writes the job's token. `mcp/server.ts` stamps `device_id` NULL on every row it writes, so those counts are frozen history and gate nothing any more. What gates a tool now is the row above and the rule below |
| **fenced by design** | `forge_orgs.list` `forge_orgs.members` `forge_collaborators` | they resolve no project, so a project-scoped PAT there is an account-scoped credential in disguise. Session only, on every transport |
| **free to go** | the rest | each has a REST twin — see [data-plane-surface.md](data-plane-surface.md). A REST twin is necessary and not sufficient: `forge_memory.search` has one and is still held by the row above, because the fleet's CLI calls the tool and not the route |

## The deletion rule, paid for once

A tool is clear to delete only when **no caller that can still reach `/mcp` would lose it**.
Since `ISS-931` that is one question with two halves, and the device count is neither of them.

1. **Is it one of the nine the fleet's `forge` CLI calls?** See the fleet-upgrade row above. That
   CLI holds a `forge_pat_*`, so `requirePat` admits it and its calls land as `token_id` traffic
   that a device split cannot see. The end state is a version rather than a judgement, and it is
   observable on any box: the installed copy at
   `~/.config/forge-runner/marketplaces/sidcorp-co__forge-plugin/plugin` is 3.35.140 and carries
   `src/tracker/rpc.mjs` with no `src/tracker/rest.mjs` beside it. When `rest.mjs` is present on
   every box, this half is discharged for all nine at once.
2. **Does anything else still call it on a token?** `token_id IS NOT NULL` rows, plus
   `skills.skill_md` on the live instance, plus the runner's own bundled text — the orientation
   `packages/runner/crates/forge-runner-core/src/workspace/orientation.rs` writes into every
   workspace names `forge_memory_search` by hand, and no audit query would have told you that.
   A tool with a caller here is refused **by name**. It is not deleted behind a widened filter,
   and the caller is not left to find out as `not_found`.

**And the replacement has to accept the credential the caller actually holds** — which, for every
caller that can still reach `/mcp`, is a `forge_pat_*`. `/api/skill-facts` is where this clause was
bought: `forge_skill_facts.get` had 23 callers and `requireAuth()` answered them 401, so the
"replacement" was nowhere they could go. Check the middleware, not the mount.

**The device count is retired as a gate.** It was the rule until `ISS-931` and it cannot be one
now. `mcp/server.ts` stamps `device_id` NULL on every row it writes, so a tool's device number is
frozen at whatever it reached and can never fall to zero. What that number fed was a clause asking
whether the callers a tool HAD could reach its replacement — and those callers are un-upgraded
boxes, which `requirePat` now answers 401 on *every* `/mcp` call, whatever is registered. A gate
that protects a population the same change already made unreachable, keyed on a number that can
never move, is a gate that never opens: wave 4 would not be blocked under it, it would be unable
to finish. The column stays in the schema and the counts stay worth reading as history — they name
which tools the un-upgraded fleet leaned on, which is the fleet-upgrade row's list seen from the
other side.

**The zero-rows amnesty survives, unchanged and still priced.** A tool at zero rows lifetime under
both spellings has nobody to strand, so it needs no reachable replacement. It is available exactly
once per tool, buys nothing for any tool with traffic, and `forge_memory.revisions` was deleted
under it on 2026-09-06. If a caller for such a tool ever appears in `mcp_audit_log` after a
deletion taken this way, the reading was wrong and the tool comes back.

**"Whole table" is a lifetime count only while the pruner stays unwired.** `mcp_audit_log` declares
90-day retention — `drizzle/migrations/0063_mcp_audit_log.sql` says so and
`auth/mcp-audit.ts:enforceMcpAuditRetention` implements it — and **nothing calls that function**.
So today a zero really does mean "never called". Wire it to a tick and the same query answers
"not called in 90 days", which would license deleting a quarterly-called tool with nothing going
red: the `7f0c5a56` shape again, arriving through the measurement rather than the column. Whoever
wires the pruner rewrites this paragraph in the same commit. Until then, read that function before
spending a zero, and note that `forge_memory.revisions` — added `f568c503` on 2026-09-05, deleted
the next day — is a zero under any retention, so it did not test this clause.


Read `mcp_audit_log` split on `device_id IS NOT NULL` / `token_id IS NOT NULL` — never on
`user_id`, which is stamped `device.ownerId` and so reads 100% user and 0 device for every tool.
Count the whole table with no date filter, and normalise with `replace(tool,'.','_')`: agents send
the underscore form their MCP client shows them.

**LEFT join the registry onto the aggregate.** A tool nothing has ever called has no row in
`mcp_audit_log` at all, so an inner join silently drops exactly the tools this rule exists to
find. The wave-3 pass reported one device-free tool and named `forge_step_handoff.delete`, which
is on the keep-forever list, and read that as "no candidates"; `forge_memory.revisions` was
sitting at zero rows lifetime and was invisible to the query. It was deleted 2026-09-06.

Commit `7f0c5a56` deleted six tools after claiming the audit log had cleared them. The split was on
the wrong column; the fleet hit one of them at 09:07 the same day and read `not_found`.

**A deletion shifts every `tools/list` index below it, and three `cm:guard`s in `server.ts` say
callers pin to that order.** Those guards govern *insertion* — they exist so a new tool is appended
rather than spliced in. Deletion cannot honour them: there is no position that leaves the tail where
it was. The shrink this page describes is a sequence of deletions, so the pinning premise cannot
survive it, and a deletion is the caller-visible change an insertion was written to avoid. Say so in
the commit that takes one out, and treat a caller that pins by index as already broken.

**The count is only readable with direct database access.** There is no aggregate route over
`mcp_audit_log` — the one route that reads the table at all is `GET /api/pat/:id/audit`, per-token
and last-N rows, and `/api/pat` is off `PAT_ALLOWED_PREFIXES` for the reason the fence section of
[data-plane-surface.md](data-plane-surface.md) gives. So an agent session on a runner box cannot
satisfy half 2 of the rule and must not delete on an estimate. Half 1 it CAN satisfy — the
installed plugin artifact is on the box and greppable — and that is the half that caught
`forge_memory.search`, `forge_projects.get` and `forge_projects.list`, all three of which the
"free to go" row had held. Whether the fence should grow a read-only aggregate, or the rule should
stop being written against a number no agent can read, is `ISS-946`.

## Who delivers the target

| Half | Issue | Where it stands |
|---|---|---|
| the CLI moves to REST | `ISS-508` on the **forge-plugin** project | closed, merged 2026-09-06T14:13Z — the boxes still run the old copy |
| one credential form for the API | `ISS-927` here | closed, merged `3291d537` |
| the runner stops handing sessions a device token | `ISS-931` here | merged 2026-09-06T19:09Z (`4e85fb69`, an ancestor of `main`), tracker row still `open` — `requirePat` on `/mcp` + the job token in `mcp/config.rs`; needs a `runner-v*` release before a box stops writing the device token |
| the waves themselves, and the record of the ones already run | `ISS-894` here | unblocked — every `blocks` edge on it is merged. Wave 4 reads the deletion rule above, and what it waits on is the fleet-upgrade row, not an issue |
| the boundary is written down | `ISS-926` here | closed, merged 2026-09-06T07:46Z |
| the rule becomes evaluable by the thing that runs it | `ISS-946` here | open — no surface aggregates `mcp_audit_log`, so half 2 above is unreachable from a box |

A dependency edge does not cross projects, so `ISS-508`'s ordering lived in both bodies as prose;
it is discharged, and so is `ISS-931`'s edge. What the remaining deletions wait on is no longer an
issue at all — it is a version on the boxes, which is why the end state above is written as a file
that has to appear rather than as a row that has to close.
