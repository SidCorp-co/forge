# A presigned upload whose response is lost is stored twice

ISS-1146 gave web conversations a file door built on the presigned ticket service that issues,
comments and agent sessions already use. A review of that change (consult `3d3fbe`, finding F7)
found a defect in the door itself rather than in the conversation half of it. It is not a new
issue — the rules refuse filing a residual as one — and it is written here so the reader who meets
it next finds it attached to evidence.

## What happens

`POST /api/uploads/:uploadId` in `packages/core/src/uploads/routes.ts` persists the bytes, burns
the ticket and answers `201` with the stored attachment. Between the row landing and that answer
reaching the browser there is a window in which the caller can lose the response — a dropped
socket, a reload, a proxy timeout. The caller has no id to cite, so it retries, and a retry mints a
second ticket and stores the file a second time. The first copy stays in storage and in
`*_attachments`, cited by nothing.

`conversation-chat.tsx` keeps the ids a queued message has already stored, so a **send** that fails
after its uploads succeeded does not upload them again. That cache starts at the acknowledgement,
so it cannot cover an upload whose acknowledgement never arrived.

## Why ISS-1146 did not fix it

Three reasons, and the first is the one that decides it:

1. **It is every target's, not this one's.** `issue`, `comment` and `session` uploads have answered
   a lost response this way since the ticket service was written. A fix that covered only
   `conversation` would leave the same hole under three callers and a reader who could not tell
   which door was safe.
2. **The repair is a design, not a patch.** What the review asks for is an operation id the caller
   mints and the door dedupes on — a column, a uniqueness rule, and a decision about how long a
   replay stays answerable. That belongs to `uploads/ticket-service.ts` as a whole, with whoever
   owns those three callers reading it.
3. **Nothing is lost to the person.** The message cites the second copy, the answer is right, the
   task completes. The cost is storage and a row nobody reads.

## What would end it

An `operationId` on the mint, carried by the PUT, with the door answering a replay with the
attachment it already stored rather than storing another. The condition that makes it worth taking
is a second reason to want it: a size cap that a duplicate pushes a project past, a quota, or a
count of orphans large enough to read in the storage bill.

## Honest costs

- **Leaving it costs storage, silently.** Every lost PUT response since the ticket service was
  written has stored a second copy that nothing cites, and nobody has counted them — the number in
  the storage bill is the only place the cost is visible, and nothing attributes it to this.
- **Taking it costs a migration and a decision about time.** An `operationId` needs a column, a
  uniqueness rule and an answer to how long a replay stays answerable; a window too short refuses a
  legitimate retry, and one too long keeps dead tickets alive.
- **Taking it touches four callers at once.** `issue`, `comment`, `session` and `conversation`
  share this door, so the change lands under three callers whose owners did not ask for it, which
  is exactly why ISS-1146 did not take it as a side effect of adding the fourth.
- **The residual is easy to lose.** This file is the only thing carrying it; no gate measures the
  defect and no row ages it, so a reader who never opens `docs/proposals/` will meet it as a
  surprise in a storage report rather than as a known trade.
