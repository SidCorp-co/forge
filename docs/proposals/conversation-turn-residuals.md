# What the conversation surface still loses around a turn

**Removed when:** a turn abandoned at its timeout writes its own `timed-out` window decision, the
fallback reply follows the room's language, and the person-stop and dock-draft questions are
answered on that issue, which dev ISS-129 carries. The change that lands it deletes this file.

ISS-1146's independent judge, at deployment `5adef4c`, recorded three losses. None of them fails a
criterion, and none of them is repaired on `ISS-1146-pair-stop`. The rules do not allow a residual
to be filed as a new issue, so they are written here, each with the reason the repair branch left it.

## 1. Stopping an answer throws away the part the person already read

**Seen:** an Assistant turn streamed about a dozen paragraphs. When the person pressed Stop, all of
them disappeared. The thread kept only "You stopped this answer, so the agent never finished it",
and reading the room back showed no stored agent message for that window.

**Mechanism:** the streamed text is progress, not a message. `assistant/turn-runner.ts` returns
`{ kind: 'stopped' }`, and `assistant/external-chat.ts` writes neither an answer nor a silence row
for a turn a person stopped. So once the stream ends, nothing the person read remains.

**Why it was not built here:** a finished answer goes through the reply check before it is stored.
`assistant/confab.ts` can withdraw a draft, and the thread says so. A cut-short answer never reaches
that check. Storing it would put text in the log that nothing has checked, labelled as the agent's.
Someone has to choose between storing it with a "cut short, not checked" mark, keeping it on screen
only, or dropping it as today. That is a product call, not a repair.

**What ends it:** that choice, recorded on whatever change carries it out.

## 2. A turn core abandons at its timeout has no window decision of its own

**Seen:** a long Assistant turn that runs to `TURN_TIMEOUT_MS` is aborted with the reason
`TURN_TIMED_OUT` (`assistant/conversation-stops.ts`), and the thread's reply is
`ASSISTANT_TURN_TIMED_OUT` in the room's own language (`conversations/fallback-replies.ts`,
`replyLanguageOf`). The window it closes still records the generic `nothing-to-say`, so a reader of
the window rows cannot tell a timeout from a turn that had nothing to add.

**Why it is not built here:** a `timed-out` decision widens `conversation_windows_decision_known`
(last set in migration 0309), which is a migration, and a migration's `when` is shared across every
open branch.

**What ends it:** a `timed-out` decision written by the timeout path.

## 3. Closing the dock discards the unsent draft

**Seen (older than ISS-1146):** text typed in the Ask-agent dock is lost whenever the dock closes.
`ISS-1146-pair-stop` removes the accidental route to that loss: a slide-over that stayed mounted
but hidden on desktop used to close the dock on any Escape. The deliberate route, the dock's own
close button, still discards the draft, because the composer's text lives in component state and
the conversation unmounts.

**Why it was not built here:** whether a closed dock should keep a draft, and for how long, is a
behaviour nobody has specified. Many chat surfaces drop it deliberately.

**What ends it:** a decision that drafts outlive the dock, and a per-conversation draft store to
carry them.

## Honest costs

- **Leaving 1 costs the person what they read.** Someone who stops an answer because they have read
  enough loses that text from the thread. Only the stop card remains, and the room read shows no
  message for that window.
- **Taking 1 either keeps unchecked text or drops it.** An answer cut short before the reply check
  can be stored with a mark saying it was not checked, kept on screen only, or dropped as today.
  Each choice gives up something the other two keep.
- **Leaving 2 keeps a state-lie on the thread.** A turn core gave up on reads as the agent choosing
  silence, which is the sentence ISS-1146 removed for a person's stop.
- **Taking 2 costs a migration.** A new window decision widens a CHECK constraint, and its `when`
  has to be read off `scripts/check-migration-order.mjs` against every open branch.
- **Leaving 3 costs a draft at every deliberate close.** Escape no longer causes that loss. The close
  button still does.
