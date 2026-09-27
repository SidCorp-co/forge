# What the conversation surface still loses around a turn

ISS-1146's independent judge, at deployment `5adef4c`, recorded three losses. None of them fails a
criterion, and none of them is repaired on `ISS-1146-pair-stop`. The rules do not allow a residual
to be filed as a new issue, so they are written here, each with the reason the repair branch left it.

## 1. Stopping an answer throws away the part the person already read

**Seen:** an Assistant turn streamed about a dozen paragraphs. When the person pressed Stop, all of
them disappeared. The thread kept only "You stopped this answer, so the agent never finished it",
and reading the room back showed no stored agent message for that window.

**Mechanism:** the streamed text is progress, not a message. `conversations/turn-runner.ts` returns
`{ kind: 'stopped' }`, and `assistant/external-chat.ts` writes neither an answer nor a silence row
for a turn a person stopped. So once the stream ends, nothing the person read remains.

**Why it was not built here:** a finished answer goes through the reply check before it is stored.
`assistant/confab.ts` can withdraw a draft, and the thread says so. A cut-short answer never reaches
that check. Storing it would put text in the log that nothing has checked, labelled as the agent's.
Someone has to choose between storing it with a "cut short, not checked" mark, keeping it on screen
only, or dropping it as today. That is a product call, not a repair.

**What ends it:** that choice, recorded on whatever change carries it out.

## 2. A turn core abandons at its timeout reads as the agent having nothing to add

**Seen (older than ISS-1146):** a long Assistant turn ran 90 s. Its window closed with decision
`nothing-to-say`, reason `This operation was aborted`. The thread said "The agent read this and had
nothing to add", and then showed the Vietnamese fallback reply (`conversations/fallback-replies.ts`)
in an English room.

**Mechanism:** `runConversationTurn` aborts on `TURN_TIMEOUT_MS` with no reason of its own. Because
the abort carries no reason, `external-chat.ts` takes it for an ordinary failure and appends a
silence row whose text is the abort's message. ISS-1146 gave a person's stop its own `stopped`
decision. A timeout still has no decision of its own.

**Why it was not built here:** telling a timeout apart needs its own window decision, which means
widening `conversation_windows_decision_known` in a migration. A migration's `when` is shared across
every open branch. The fallback reply's language is a separate question: which language that door
answers in.

**What ends it:** a `timed-out` decision written by the timeout path, plus a fallback reply that
follows the room's language.

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
