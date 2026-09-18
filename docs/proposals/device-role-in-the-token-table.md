# The device role in the token table cannot leave without a box losing its way in

**Status:** settled as "not now", with the reasoning recorded. Raised and answered inside ISS-1003,
which asked for exactly this: settle it before building, and if it cannot be resolved without
breaking how every paired box authenticates, say so and land the rest.

## What was asked

`personal_access_tokens` serves three roles today and the issue's position is that it should serve
two:

- a **person's** token, owned by a `users` row of kind `human`;
- an **agent's** token, owned by a `users` row of kind `agent`;
- a **box's** credential, which is any of the above carrying a non-null `device_id` — and that
  non-null value is the entire authority to speak as that box.

The third was to be removed. It is not a rename: taking the role away takes away how every paired
runner authenticates, and the obvious replacement collides with a rule the same issue puts out of
scope.

## Why the obvious replacement does not work

Give the box an agent account and let it hold an Agent Access Token. Then:

1. ~~**An agent belongs to exactly one project; a box serves many.**~~ **Taken, in ISS-1093.** An
   agent now holds N project memberships and one credential fenced to exactly those projects, so
   this objection no longer stands. The readers that assumed one were re-priced there:
   `listAgentAccounts` folds its rows per agent, `fenceFor`/`agentCredentialFence` became the one
   place a fence shape is chosen, and `conversations/handles.ts:existingProjectHandle` now requires
   a candidate to be a member of this project and no other — see point 3, which was right.
2. **A box is not org-scoped either.** An agent holds one organization membership and its address is
   unique within that organization. A runner box paired to projects in two organizations cannot be
   represented as one agent at all, in any number of projects.
3. **The project handle resolver would find it.** A project's conversation handle is resolved as
   "the agent that is a member of this project", oldest first. A box-shaped agent joining a project
   becomes a candidate to be that project's voice in a chat room, and the only way to exclude it is
   a check that tells one agent from another — which ISS-1003's rule 1 names as the signal that the
   check is wrong rather than that a branch is missing.

## Why the other way out is a reversal

The alternative the issue offers is a box authenticating "as something that is neither, named and
designed here". That thing existed: a per-device credential table, which ISS-932 deleted on purpose
when it made `devices` a registry rather than a species of token. Re-introducing it restores the
second live authentication path that deletion removed, and it does so at the one place where a
second live path is most expensive — the door every runner comes through.

## What was done instead

Nothing, deliberately. `personal_access_tokens.device_id` stays exactly as it is, and no half of the
removal was built: there is no new column, no parallel table, and no compatibility branch. The issue
is explicit that a half-removal, or an old path running beside a new one, is worse than the
three-role table.

What ISS-1003 *did* change is the axis that was actually wrong. Attribution no longer guesses who is
speaking from the shape of a shared credential: an agent's own token names that agent, a person's
token establishes nobody, and a session is the only thing that establishes a person. `device_id`
keeps answering the question it was always answering — which box was this issued to — and it is no
longer asked to stand in for who is speaking.

## Honest costs

Choosing "not now" is not free, and these are the bills it leaves:

- **The table keeps three roles and one of them is undocumented in its own shape.** A reader of
  `personal_access_tokens` cannot tell a box's credential from a person's except by a nullable
  column, and the only thing that says which is which is a `cm:guard`. Anyone adding a fourth
  surface to that table inherits that ambiguity rather than a type.
- **`device_id` stays a second identity axis beside `agentUserId`.** ISS-1003 added a clean answer
  to "which agent is speaking" and left "which box is this" where it was, so two questions of the
  same shape are now answered by two mechanisms of different shapes. That is one more thing a new
  surface has to learn, and one more place the two can be confused.
- **The one-project rule stays untested against the case that would break it.** Nothing in the
  suite exercises an agent with two project memberships, because nothing creates one. The day the
  rule bends, it bends without a failing test to say what else assumed it.
- **The work is deferred, not removed.** Whoever takes this up pays the whole price then, on a
  larger surface than today's, because every agent-account reader added between now and then is
  another reader to re-price.

## What would have to be true to take it up again

One of these, and not a smaller version of either:

- ~~A decision that an agent account may hold more than one project membership~~ — **made in
  ISS-1093**, as its own change, with the handle resolver re-priced against it exactly as this
  document asked. What it did NOT settle is objection 2: an agent still holds one organization
  membership, so a box paired to projects in two organizations still cannot be one agent. That is
  what remains between here and taking this up again.
- Or a designed third principal for a machine, with its own answer to what it is a member of, what
  it may reach, how it is revoked, and what it is called in an audit row. That is a redesign of the
  device plane, not a column.

Until one of those is chosen, the table serves three roles and this document is why.
