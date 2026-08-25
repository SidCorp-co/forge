# MCP cannot tell a human from an agent acting as one

**Found:** 2026-08-25, while fixing what looked like a one-line actor bug.
**Status:** blocked on a decision — needs a model of agency, not a patch.

## Symptom

A human holding a PAT cannot close an issue on a project with a release gate:

```
forge_issues transition → closed
NO_OP: issue already in status tested
```

Every MCP tool that records an actor hardcodes `{ type: 'device', id: device.id }`.
For a PAT principal `device` is `stubDeviceForPat` (`mcp/handler.ts:17`), whose `id`
is the **PAT token id**. So the audit trail records a device that does not exist,
and every gate reading `actor.type` sees a machine.

## Why the obvious fix is wrong

`principal.kind === 'pat' ? user : device` — the shape `forge-release-batch.ts:85`
already uses — reaches three consumers, not one:

| consumer | today | after |
|---|---|---|
| `transition-evidence.ts:129` — ISS-812 fabrication guard | `actorType !== 'device'` returns null, so the guard runs | guard **stops running** for every PAT call |
| `apply-transition.ts:217` — comment labeling | `isAi: actor.type !== 'user'` → true | `isAi: false`, reversing ISS-820 in one path only |
| `apply-transition.ts:305` — `publishIssueStatusChange` actorId | device ownerId | user id (this one is simply correct) |

The first is the blocker. `chat/tools/principal.ts:47` builds `kind: 'pat'` for the
**chat surface**, which is agent-driven. Mapping PAT to user would exempt every
agent chat write from the fabrication guard — a guard added because agents were
fabricating evidence.

## What is actually missing

`McpPrincipal` has two kinds and three callers:

1. a human with a real PAT — owner lane
2. the chat surface, agent-driven, acting as that human
3. a runner with a device token

`kind` separates 3 from {1,2}. Nothing separates 1 from 2, so no rule keyed on
`kind` can be right for both. `CHAT_TOKEN_ID = '__chat_synthetic__'` distinguishes
case 2 by sentinel, which is evidence the distinction is already needed and
already being faked.

## Shape of a fix, for whoever takes it

Add agency to the principal rather than deriving it from `kind` — something like
`agency: 'human' | 'agent'`, set at authentication: a real PAT is `human`, the
chat context is `agent`, a device token is `agent`. Then `actor.type` follows
agency, the ISS-812 guard keys on agency rather than on `actor.type === 'device'`,
and ISS-820's labeling decision gets re-made deliberately with the distinction
available instead of being flipped as a side effect.

Not attempted here: it changes who a fabrication guard applies to, which is not a
call to make as a cleanup.
