# A tracker write now waits on GitHub

**Status: OPEN, priced by ISS-1072 (2026-09-17). Needs a publisher, not a refactor of what shipped.**

ISS-1072 made Forge publish `forge/issue-contract` on a pull request and required, in its fourth
outcome, that the check re-publish on every event that changes the answer and **never by polling**.
Event-driven is what shipped: the publishes hang off the hooks bus, off `transition`,
`contractInputChanged` and `dependencyChanged`, and off the `pull_request` delivery. Nothing ticks.

What the issue did not say, because it is a property of the bus rather than of the check, is that
**`HooksBus.emit` awaits every subscriber in registration order.** So the publish that was designed
to be a reaction is, from the caller's side, a step.

## The shortfall

`updateIssueFields`, `applyMergeMarker`, `writeIssueContext`, `deleteIssueContext`,
`updatePipelineConfig` and the project settings PATCH each emit `contractInputChanged` after their
own write has committed, and each therefore returns only once the publish has finished talking to
GitHub.

The cost, per publish: a token mint (cached, five-minute margin), a lookup and a write, each bounded
by `PUBLISH_TIMEOUT_MS` at 8s — so around 24 seconds of HTTP, and that is a floor rather than the
figure. The wait a caller actually sees adds getting a pooled connection and waiting on the advisory
lock behind whatever other publish holds that head, neither of which is bounded by the request
timeout. Typically it is a few hundred milliseconds. `forge record plan` and `forge record criteria`
come through `updateIssueFields`, so an agent writing a plan on an issue with an open pull request
pays it.

The worst case is the fan-out. A change to what a status requires republishes **every** open pull
request on the project, up to `PROJECT_REPUBLISH_CAP` of 25, sequentially — so a settings save can
hold its HTTP response for minutes while GitHub is slow.

Two things already bound the damage and neither removes it. The subscriber is registered **last** in
`eager-subscribers.ts`, so every local subscriber has already run before the network one starts; and
each handler is `guarded`, so a GitHub outage never reaches the caller as a failure. It reaches it as
a wait.

## Why this is not a line to change

The obvious fix — stop awaiting — is worse than the wait, and it is not a cheap version of the right
one. A floating promise loses the failure that `guarded` logs and the delivery row that
`contract-check.ts` writes, and `HooksBus.emit`'s own `failures` array is what `outbox-worker.ts`
keys its processed-vs-failed decision on. Dropping the await drops the one record saying a publish
was attempted, and it keeps none of the ownership or the retry that make the queue below worth
having.

The real fix is a **bounded publisher** with per-(binding, head) ownership: the subscribers enqueue
and return, the publisher drains, and the delivery row moves with the publisher rather than with the
caller. That is a queue with its own retry, its own ordering and its own failure surface — the third
of those being the reason it is not a detail of this issue. The advisory lock in `check-run.ts` would
then be the publisher's exclusion rather than the caller's, and the cap would bound a queue depth
rather than a loop.

## What holds until then

- The publish is inside a transaction that holds ONE pooled connection, not two: ISS-1072's review
  found the second read and `contract-answer.ts` now takes the caller's executor. Ten concurrent
  publishes therefore occupy ten of ten connections rather than deadlocking on an eleventh, and
  `tests/integration/github-contract-check-lock-e2e.test.ts` is what says so.
- Every gap between HTTP calls inside that transaction is bounded by the 8s request timeout, which is
  under `DATABASE_IDLE_IN_TX_TIMEOUT_MS` at 30s, so the transaction is not killed mid-publish.
- A project that does not want the cost turns the check off on its GitHub binding with
  `contractCheck: false`, which is one PATCH and no deploy.

## Honest costs

The prices below are of the bounded publisher, not of the wait it removes.

| Cost | What it takes |
|---|---|
| A third place a publish can be lost | Today a publish either happened or left a `failed` delivery row in the caller's own request. Behind a queue it can also be enqueued and never drained, which is a state nothing in `integration_deliveries` represents and nothing sweeps — so the queue owes its own depth and age readout before it is trusted. |
| The delivery row stops answering the caller | `dispatchOutbound` returns a `deliveryId` today and the row is terminal by the time it does. Enqueueing makes that id a promise, so `OutboundDispatchResult` either changes shape or starts naming a row whose outcome arrives later. |
| Retry becomes a policy somebody owns | Awaiting means a failed publish is simply a failed publish, and the next event republishes. A queue that retries can republish a stale answer after a newer one has landed, so it needs per-(binding, head) ordering — the advisory lock moves into the publisher and stops being the caller's. |
| A second exclusion mechanism to keep honest | `check-run.ts`'s lock and the queue's ownership would both be saying "one publish per head at a time". Two mechanisms agreeing is a thing to test; two mechanisms disagreeing is a duplicate check run, which is the failure this whole layer is built to avoid. |
| Ordering against the tracker write weakens | The publish currently runs after the caller's transaction committed, in the same process, so it cannot read a row that is not there. Draining elsewhere makes that a timing assumption instead of a sequence. |

## The condition that ends this

A publisher queue, or a hooks bus that can carry a subscriber it does not await. Whichever lands
first, `contract-check-subscribers.ts` is the one file that changes here.
