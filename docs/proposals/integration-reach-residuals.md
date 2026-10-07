# What ISS-1191 could not reach

**Removed when:** the direct-mcp authority question is answered on that issue, which dev ISS-122
carries. The change that lands it deletes this file.

ISS-1191 made one surface report every source of an agent's MCP servers. One thing it met is not
that change, and is not a new issue — the rules refuse filing a residual as one. It is here so the
next reader finds it attached to evidence rather than rediscovering it.

## A direct-MCP grant is readable and writable only by an org admin

`agentAccessTier` in `packages/core/src/integrations/agent-access.ts` returns `org-admin` for every
provider whose declared agent path is `direct-mcp`, and `bindEffects.refusals` in
`packages/core/src/project-config/bind-effects.ts` enforces it on the one binding write
(`AGENT_ACCESS_NEEDS_ORG_ADMIN`). The reasoning is sound and written down
there: a `direct-mcp` grant hands the project's own credential to a runner box, which is the same
escalation that already guards secrets on an org-owned connection.

The cost is that the field it produces is the one ISS-1191 was filed about. Measured on 2026-09-25
by an independent judgement over the 36 projects one box's credential holds a role on: four carry a
Sentry binding and **every one of them answers `not_granted`**; the other 32 answer `no_binding`.
forge-dev's own binding is connected, healthy and declares the right targets, and its `agentAccess`
is `none`. Nobody who works these projects day to day can see that, and nobody who works them can
change it.

ISS-1191's change makes the state legible — the preview row reads `not_granted` beside the servers
that do reach an agent, and the panel carries the reason and the grant control. It does not decide
who may operate that control, and that is the open question: whether a project admin may grant a
`direct-mcp` binding on a project whose credential they already administer, or whether the
escalation stands and the product instead has to make the org admin's attention reachable.

It is a decision about credential authority, so it is a person's and not a diff's.

## Honest costs

| Choice | What it costs, and who pays |
|---|---|
| Leaving a `direct-mcp` grant at `org-admin` | The people who run these projects cannot fix the thing they will most often need to fix. Every Sentry binding on this box is ungranted and the person who could change that is not the person who notices. ISS-1191 buys them a surface that says so, which turns a silent failure into a visible one they still cannot act on. |
| Moving that grant to project admin | An escalation that exists for a reason goes. A project admin could then export a credential an org admin provisioned onto a runner box, and the audit trail becomes the only thing between that and a leak. |
