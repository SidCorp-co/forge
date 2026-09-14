# A chat reply cannot say which of the two it is

**Status: OPEN, priced by ISS-997 (2026-09-14). Needs a product decision, not a refactor.**

ISS-997 built the message contract on two questions asked of every agent-written message: who
reads it, and what does it ask of them. The reader holds a role or holds none; the message asks
(the reader owes an answer) or reports (the reader owes nothing). Four cells, each with its own
rules.

Three of the four are wired to doors. The fourth, `public:ask`, ships with rules and **no door**,
and this document is why.

## The shortfall

A person with no role on the project reaches Forge in a chat room. Everything an agent writes back
to them today goes through `public:report` — the chat-sync reply, the escalation synthesis, and the
final message of a runner session. All three are declarations.

But a reply in a room is often really a question: *which environment did you mean?* *do you want
the staging one?* The agent asks it, the person answers it, and the conversation continues. The
contract has no way to see that. The message is screened as a report, and `no-empty-promise` —
a rule that exists to stop an agent committing to something nothing will hold it to — is applied
to text whose whole purpose is to open a commitment the person is being invited to close.

So `public:ask` cannot simply be folded into `public:report`: doing so would refuse the single
message that reader is there to answer. And it cannot be wired to a door either, because **nothing
in the product declares which of the two a given chat reply is.**

## Why the fix is not a classifier

The obvious move is to infer it — a question mark, an interrogative opening, a model asked to
label the turn. Every version of that is the same mistake in a new coat:

- The contract's own rule is that a rule is about what a message **claims**, never about what it is
  made of. A cell chosen by pattern-matching the text is a cell chosen by what the message is made
  of.
- A wrong inference does not fail loudly. It screens an ask against report rules, or the reverse,
  and the author is refused by a rule that was never meant for its message — or passed by one that
  was.
- It would put a guess in the kernel path of every outbound message, which `VISION:
  kernel-hard-policy-soft` does not permit.

The intent has to be **declared by whoever composes the message**, the way the audience already is.
That is a change to how a chat turn is produced, not a change to how it is screened.

## What a decision would have to settle

1. **Does an agent in a chat room ask questions at all, as a product?** If the answer is that a
   room reply is always a report and a genuine question goes through the question round machinery
   (`questions/write.ts` → `question-delivery`), then `public:ask` should be deleted rather than
   left reserved, and this document closes.
2. **If it does ask**, which surface declares the intent — the model's own turn shape, the tool it
   called, or the adapter that knows whether a thread is awaiting a reply?
3. **What does an unanswered `public:ask` become?** A question round has a park, a deadline and a
   max-rounds ending. A chat ask has none of those, and an ask nobody answers is work stopped with
   nothing tracking it.

## What was done instead, and what it costs

`public:ask` is registered, carries its rules, and is marked reserved. `cells.ts` asserts it is
wired to no door and `doors.test.ts` asserts every door names a cell that exists, so the reserved
cell cannot be reached by accident and cannot be quietly deleted either.

The cost of leaving it: a chat reply that is genuinely a question is screened as a report today,
and `no-empty-promise` may refuse it. That is a real refusal a person can hit, and it is the reason
this is priced here rather than left implied. It is not a silent failure — the author is told which
rule refused it — but it is the wrong rule, and no rewrite of the message will make it the right
one.

The condition that ends this: a product decision on question 1 above.
