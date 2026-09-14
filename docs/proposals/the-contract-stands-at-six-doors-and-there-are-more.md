# The contract stands at six doors, and there are more

**Status: OPEN, found and measured by ISS-997 (2026-09-14). Needs a per-surface decision before any
of it is wired.**

ISS-997 built the message contract and stood it at the six doors its criteria name: the comment
write, the two question doors, and the three chat replies. Those were the doors the issue was
written about, and the gap it named — a comment checked for markup and never for truth — is closed.

While answering a reviewer's question (*is there any other place an agent's words reach a person
that this contract does not stand at?*) I enumerated the outbound paths. **There are more, and some
of them carry more text than the ones now screened.** This document records what was found, so the
next reader starts from a list rather than from the same search.

## What was verified in the source

| Path | What it carries | How an agent authors it |
|---|---|---|
| `agent-sessions/turns-routes.ts` PATCH → `agent-sessions/broadcast.ts` | up to **40,000 characters** replacing a turn's user-visible content, streamed live to the browser | `requireUserOrDevice()` — a paired runner box, `agency:'agent'` by construction |
| `agent-sessions/auto-title.ts` `generateSessionTitle` | an LLM-generated session title written to `agent_sessions.title` and broadcast | `callFastModel` output; only `isSystemNoise` / `stripSystemNoise` stand between the model and the field |

Both were read directly. The first is the largest uncovered agent-text-to-browser path in the
product; the second is model output landing in a UI field with no screen at all.

## What was enumerated but not individually verified

Reported by a survey of the tree and worth checking before anyone builds on it, not worth
re-finding from scratch:

- `pm/decisions-service.ts` `writePmDecision` — an agent's `summary` becomes a notification title and
  its `question` and option labels become the body, fanned out over the websocket as
  `pm.escalation`.
- `skills/reconcile-service.ts` `record_verdict` / `record_vote` — an **unbounded** agent-written
  `candidateBody` is published as a skill body that a person reads and an agent then runs.
- `jobs/lifecycle-routes.ts` — `summary` and `error`, 10,000 characters each, behind
  `requireDevice()`, re-read for the failure-cause surface.
- `integrations/rocketchat/connection-manager.ts` `deliverAndRecord` and
  `conversation-port.ts` `deliver` — the two send sites the screened bridges funnel into.
- `activity_log` payloads read by the issue activity feed: park reasons, dependency-edge reasons,
  and `before`/`after` for every agent-written issue field.
- The MCP field writes — `forge_issues` (`title`, `description`, `plan`, `acceptanceCriteria`,
  `releaseNotes`), `forge_knowledge`, `forge_guide`, `forge_feedback`, `forge_ux_findings`.

## Why this is not simply "wire the rest"

Each surface needs an **audience and an intent decided for it**, and that is a judgement rather than
a mechanical change:

- A session turn streamed to the person who owns the session is `role:report` — but a turn is not a
  finished message, it is a transcript, and refusing one mid-stream has no defined behaviour. There
  is no door shape yet for "a thing that is still being written".
- An issue `description` an agent writes is read by a role holder, so `status-matches-the-row` would
  apply — and an agent writing a plan that *says* it will merge something is not making a claim
  about the present. The tense distinction the comment grammar makes would have to hold here too.
- A session **title** is three to six words with no room for a citation; every rule in
  `role:report` except `no-redacted-secret` is close to meaningless on it.
- `jobs/lifecycle-routes.ts`'s `error` is a stack trace by design. `no-developer-detail` exists to
  keep exactly that away from a reader with no role — and this reader is an operator who needs it.

Wiring these without settling each of those turns the contract into a list of call sites, which is
the failure ISS-997 was careful to avoid when it dropped the `escalate` door for the same reason.

## Two attribution defects found on the way, which are smaller and more fixable

Both are places the product records an agent's writing as a person's, which would exempt it from
this contract *and* drop it out of any number measuring the contract's reach:

- `pipeline/outbox-worker.ts` — the outbox row carries no agency, so a rebuilt transition is
  attributed to a human even when a job token drove it. Already noted in-tree.
- `uploads/routes.ts` — `'human'` is a hardcoded placeholder for ticket-authenticated uploads, so an
  agent's upload and its filename are filed under a person.

## Honest costs

The price of doing the work this proposes, not of the gap it names.

| Cost | What it takes |
|---|---|
| A decision per surface, before any code | Audience and intent are judgements about who reads a thing and what it asks of them. There are a dozen surfaces here and no rule that derives the answer from the call site — deriving one would be the pattern-matching this contract forbids. |
| A door shape that does not exist yet | A streamed turn is written in pieces. Every door today screens a finished message and refuses or passes it whole; "refuse a message still being written" has no defined behaviour, and inventing one is a design change to the contract, not an application of it. |
| Rules that are near-meaningless on short fields | On a 3-to-6-word session title, four of the five `role:report` rules can never fire. Screening it anyway buys a cell whose verdict is always the same, which is worse than not screening it: it reads as covered. |
| A rule that must not fire where it currently should | `no-developer-detail` exists to keep stack traces from a reader with no role. A job's `error` field is a stack trace for an operator who needs it. Extending the contract there means either a new audience or an exemption, and the issue that built this explicitly excluded new audiences. |
| Latency and a transaction on paths that have neither today | `status-matches-the-row` costs up to two queries. The turn-append path is streamed and hot; putting a tracker read in it is a cost that path has never paid. |
| Doing it in one change would re-make the mistake | ISS-997 dropped the `escalate` door once it turned out to be agent-to-agent. Wiring a dozen surfaces at once, without the per-surface decision above, produces a table of call sites rather than a table of messages to people — which is the thing the contract is defined against. |
