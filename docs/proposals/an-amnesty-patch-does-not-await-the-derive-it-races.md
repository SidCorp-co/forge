# An amnesty PATCH does not await the derive it races

**Status:** Open residual, measured, no fix proposed. Found by ISS-1090 while reading a CI red it
did not cause.

## What is wrong

A daemon on the release before ISS-1030 reports its own transcript in a terminal `PATCH`'s
`messages`. `agent-sessions/patch-transcript.ts:applyTranscriptPatch` converts it and hands it to
the route to write. That write can be silently overwritten by a derive already in flight over the
same session's carrier events.

`agent-sessions/events-routes.ts` fires `maybeDeriveIncrementalFor({ kind: 'chat' }, sessionId, n)`
and **voids** it, by design — the comment says so, and it is right to: a throw there would fail line
ingest to protect a transcript the next batch rebuilds. `jobs/session-transcript.ts` keeps that
promise on its handle (`st.inFlight`), and **`deriveChatTurnFinal` awaits it** before its own
derive, precisely because the two must not interleave.

The amnesty branch never reaches `deriveChatTurnFinal`. Its gate is
`patch.messages === undefined && patch.toolCallCount === undefined`, and an old daemon's PATCH
carries both, so it takes the other path — which awaits nothing.

**The compare-and-swap does not save it, and reading it as a defence is the trap here.** Every
derive writes under a fingerprint over the two columns it owns, so a derive holding stale bytes
cannot overwrite a newer transcript — that is ISS-1020's rule and it holds. But losing the swap is
not an abort. `runDerive` clears the checkpoint and **re-derives against what now stands**, up to
`DERIVE_CAS_ATTEMPTS` (3), logging *"the stored transcript moved under this derive — re-deriving
against it"*. So when a derive reads before the amnesty's write and tries to write after it, the
CAS does not discard the derive: it rebuilds it whole from the carrier events, against a baseline
that is now the reported transcript, and stores that. The reported rows are replaced by derived
ones computed *after* seeing them.

That is the outcome `patch-transcript.ts`'s own `cm:guard` says must never happen: *"deriving over
it would replace what it reported with the prompts and none of the answers."* The guard is kept
against widening the gate, and lost to an ordering nobody gated. Nothing in the amnesty path tells
the derive that this session's transcript is no longer derivable.

## The evidence

`tests/integration/chat-transcript-amnesty-e2e.test.ts` — *"leaves an old daemon's reported
transcript alone rather than deriving over it"* — is the assertion that catches it. It posts a turn
that ran tools (six carrier events), PATCHes one reported message, and expects one row.

- CI, whole suite, 2026-09-18: `expected [ { …(4) }, …(3) ] to have a length of 1 but got 4`. Four
  is what that turn derives to; the amnesty promises one, and nothing else in the test writes to
  that session.
- Alone at the same head: 8 of 8 green, repeatedly.
- ISS-1068 recorded the same file failing 2 of 4 whole-suite runs and 8 of 8 alone, hours earlier
  and at a different base, and judged it outside its own change's reach.

Passing alone and failing in-suite is the signature: alone, the voided derive finishes before the
PATCH; under load it does not. Nothing about the count is random — it is always the derived turn.

## Why it is not simply a flaky test

The test's expectation is correct and must not be relaxed. One row is what the amnesty promises.
What the flake reports is a real window in which a running system loses an un-upgraded daemon's
transcript and keeps the prompts, and the only reason it is rare in the field is that the incremental
derive is throttled.

Equally, making the test deterministic by awaiting the derive inside the test would close the
assertion and leave the product race open — a repair that hides its own subject.

## What closing it needs

Someone who owns `agent-sessions` decides where the wait belongs, because each option prices
differently:

1. **Await `st.inFlight` in the amnesty branch**, as `deriveChatTurnFinal` already does. Smallest,
   and it makes the two paths symmetric. Costs a terminal PATCH the tail of one in-flight derive.
2. **Mark the session finalized before the write**, so a derive that lands late is refused rather
   than re-derived. Cheaper on latency, and it needs no new concept: `runDerive` already reads
   `finalized`, and the CAS retry is exactly the loop that has to be told to stop.
3. **Make the reported transcript win by rule** — a stored marker saying this session's transcript
   was reported rather than derived, which no later derive may overwrite. The most honest of the
   three and the largest.

Whichever is taken, the planted violation is the one CI already found: post a turn that ran tools,
hold the incremental derive, PATCH the amnesty, and assert one row.

## Honest costs

| Choice | What it costs whoever takes it |
|---|---|
| **1. Await `st.inFlight` in the amnesty branch** | Latency on every terminal PATCH, not only the racing ones: the request holds while a derive reads every carrier event and folds them, on the slowest turn a box reports. It is charged to the un-upgraded daemon, on the path that exists to be kind to it. |
| **2. Mark the session finalized before the write** | A meaning. `finalized` today says *the transcript was derived and its events may go* — ISS-1027's retention rule reads the marker as permission to delete them. Setting it from the amnesty path makes it also say *this transcript was reported*, so either retention deletes events behind a transcript nobody derived, or it grows a second condition. That condition is the real work, in the subsystem that can least afford a wrong answer. |
| **3. A stored marker saying this transcript was reported** | A column, a migration, and every derive path learning to read it. It also changes what a stored transcript is: one value with one writer at a time becomes a value with a provenance. It is the only option whose answer does not depend on who wrote last. |
| **4. Leaving it** | A rare silent loss in the field — it takes an old daemon, a terminal turn, and a derive already running, and the flush is throttled at 30s or 8 stdout lines. When it happens nothing reports it: the transcript looks complete and holds the prompts with none of the answers. In CI it costs a red that passes on re-run, which is the cost that actually gets paid, and the one that teaches a reader to re-run rather than to look. |

## Why ISS-1090 did not fix it

It is another subsystem's ordering rule over kernel-adjacent session state, and the fix changes what
a terminal PATCH means. That is a decision and a review that belong with the transcript amnesty, not
with a room's search index. ISS-1090 touches nothing under `agent-sessions/` or `jobs/`: its runtime
modules import `db/client`, `db/schema-conversations`, `db/schema-transcript-index`,
`db/schema-types`, `assistant/conversation-access`, `queue/boss` and `logger`, and they write only
`conversation_passages` and `conversation_index_state`.
