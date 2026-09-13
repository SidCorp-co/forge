# Answering a question on a personal access token is refused, and nobody has decided otherwise

- Status: **refused in code since ISS-993, 2026-09-13.** Nothing is broken today; what is open is
  whether the refusal is the permanent answer.
- Related: `packages/core/src/questions/routes.ts` (`sessionOnly`) ·
  `packages/core/src/auth/pat-permissions.ts` (`PAT_PERMISSION_RESOURCES.questions`) ·
  `packages/core/src/middleware/auth.ts` (`restAuthored`, and the `agency` guard on it) ·
  `docs/proposals/agent-answer-mode-has-no-speaker-identity.md`

## What ISS-993 did, and the door it had to hold shut

ISS-993 put `/api/questions` on the PAT permission menu so an agent holding a token can ask a
question against an issue, list a project's open ones, and read an answer back. A prefix is the
finest grain that menu has, so the same entry carried `POST /api/questions/:id/answer` and
`POST /api/questions/:id/void` with it — and an **absent or empty** grant array reads as holding
every group, so every token minted before the grants column existed would have gained the authority
to answer. Those two handlers therefore refuse a token by name, with `403 QUESTION_NEEDS_SESSION`.

The level split is not the defence people expect it to be. A token granted exactly `questions:read`
is refused upstream, in middleware, because answering is a `POST`. A token granted nothing is
refused by the handler, because the menu already let it through. Only the second case needed new
code, and it is the common case.

## Why `agency` is not the test

The obvious rule — refuse an *agent* rather than refuse a *token* — does not hold. `agency` comes
from the token owner's `users.kind`, so an agent working on a person's PAT reads `human`; the guard
on `restAuthored` in `middleware/auth.ts` carries that measurement, taken 2026-09-13 on ISS-978. A
rule written on `agency` would refuse a box's own agent credential and wave through every agent
running on a person's token, which is most of them. That is a lock drawn on the screen and nowhere
else.

## What is actually undecided

Whether a credential should ever answer a question at all, and if so which one.

- A **person's** integration answering their own queue over a token is a reasonable thing to want,
  and the refusal blocks it. Nobody has asked for it yet.
- A **peer agent** answering a question whose `blocker_kind` is `master_or_peer` is the case the
  type was built for — `questionBlockerKinds` distinguishes `machine`, `master_or_peer` and `human`
  precisely so not every question needs a person — and today no credential can do it over HTTP at
  all. That is the sharper gap, and it is a decision about authority rather than about plumbing.
- Either answer wants a way to tell *who* is at the keyboard that survives a shared token, which is
  the same question `agent-answer-mode-has-no-speaker-identity.md` could not settle.

## Honest costs

Priced against lifting the refusal, not against keeping it — nobody is blocked from anything they
could do before ISS-993.

| Cost | Who pays it, and when |
|---|---|
| The menu's grain, spent | Lifting it for one case lifts it for every ungranted token at once, because the prefix is the unit. Paid by every legacy token on the instance, on deploy. |
| A speaker identity that does not exist | Answering is attributed to `answeredBy`, and a shared token names its owner and not whoever is holding it. Paid as a wrong attribution, quietly, and read back later as a decision a person did not take. |
| `mayChoose` re-audited | It gates on the project role, which a token inherits whole. A token answering means the `authority: 'admin'` lock is worth exactly as much as the token's owner's role, which is not what the lock was drawn for. Paid before the first answer, or afterwards as a lock that was decorative. |
| The cheap alternative is already built | A person answers in the room ISS-978 delivers to, or in a browser. Keeping the refusal costs nobody a capability they have; it costs a reader one more rule to know. |
| Doing nothing has no alarm on it | The `master_or_peer` gap stays invisible, because the surface that would expose it is the one this refusal closed. No owner, no signal. |
