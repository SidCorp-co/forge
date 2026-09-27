# What ISS-1191 could not reach

ISS-1191 made one surface report every source of an agent's MCP servers. Two things it met are not
that change, and neither is a new issue — the rules refuse filing a residual as one. They are here
so the next reader finds them attached to evidence rather than rediscovering them.

## A direct-MCP grant is readable and writable only by an org admin

`agentAccessTier` in `packages/core/src/integrations/agent-access.ts` returns `org-admin` for every
provider whose declared agent path is `direct-mcp`, and `authorizeAgentAccessWrite` in
`packages/core/src/integrations/routes.ts` enforces it. The reasoning is sound and written down
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

## An unreadable session file and an absent one are one answer

`session_matches` in `packages/runner/crates/forge-runner-core/src/mcp/config.rs` reads the session
config with `read_to_string(&path).ok()`, so a file it cannot read — a permission fault, bytes that
are not UTF-8 — arrives as `None`, the same value an absent file produces. Over an empty
declaration that pair maps to `true`: the box reports agreement with a file it never established
the contents of.

`forge-runner doctor` no longer relies on that (ISS-1191 gave its MCP row four states of its own —
absent, unreadable, matching, differing — and an unreadable file is a cross naming the reason), but
the conflation is still there for its other caller, the daemon's master sweep, which reads it to
decide whether a live pane's config still says what core says now.

It was not fixed at the source because the sweep's behaviour on that answer lives in
`packages/runner/crates/forge-runner-core/src/daemon/master.rs`, which another run held uncommitted
while ISS-1191 was being worked. What a sweep should do with a file it cannot read is also a real
question — rewrite it, refuse the pane, or report and leave it — and it is not one a change about
reporting should settle on the way past.

## Honest costs

| Choice | What it costs, and who pays |
|---|---|
| Leaving a `direct-mcp` grant at `org-admin` | The people who run these projects cannot fix the thing they will most often need to fix. Every Sentry binding on this box is ungranted and the person who could change that is not the person who notices. ISS-1191 buys them a surface that says so, which turns a silent failure into a visible one they still cannot act on. |
| Moving that grant to project admin | An escalation that exists for a reason goes. A project admin could then export a credential an org admin provisioned onto a runner box, and the audit trail becomes the only thing between that and a leak. |
| Leaving `session_matches` conflating unreadable with absent | The daemon's sweep keeps the blindness doctor just stopped having: a pane whose config cannot be read reads as agreeing. Narrow — the file is written by the user that reads it — and paid by whoever debugs the pane that carries the wrong servers. |
| Carrying the four-state read in doctor alone | One more place knows the session file's shape. The alternative is a behaviour change to the master loop, deciding what a sweep does with a file it cannot read, which is not a reporting change. |
