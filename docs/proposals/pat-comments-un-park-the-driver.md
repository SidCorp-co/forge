# A driver's own comment un-parks the issue it just parked

**Status:** found 2026-09-06 while driving ISS-593, on the run that hit it. Reported rather than
fixed, because closing it means deciding whether a PAT-authenticated write is a person — which is
an access-model question, not a module-taxonomy change's to answer.

## What happened, measured

ISS-593 was parked at `needs_info` at `23:49:24Z`. A comment was posted at `23:51:18Z`. One second
later, `23:51:19Z`:

```
issue.statusChanged {"to": "open", "from": "needs_info", "reopenCount": 0}
```

Nobody read the comment. The driver had written it itself, and it was the driver's own park that
the comment lifted.

## Why the guard did not hold

`pipeline/answer-resume.ts` subscribes to `commentCreated` behind exactly the right check:

```ts
// cm:guard every AI comment path emits a `device` actor (mcp/tools/forge-comments.ts,
// forge-issues.ts) — widening this to any actor would let the driver's own question resume the
// issue it just parked, in a loop nothing else stops
if (p.actor.type !== 'user') return;
```

The guard names the failure precisely and then rests on a premise that is no longer true. It holds
for the two MCP tools it cites. It does not hold for `POST /api/issues/:id/comments` authenticated
by a personal access token — which is a `user` actor, because a PAT *is* a person's credential, and
which is the transport the autonomous driver prompt tells a session to use:

> Reach Forge through `forge-runner api <path>` … Use this and not a `forge_*` tool.

So the one lane where an agent cannot reach the MCP tools is the one lane whose every comment reads
as a human answering. The `device` actor the guard filters on is set by `authorDeviceId`, and the
REST route leaves that null by design (`db/schema.ts:comments.authorDeviceId` — *"the human REST
path leaves it null"*).

## What it costs

A park is the driver's way of saying a run cannot proceed. This turns it into a suggestion: any
run that parks and then writes one more comment — a finding, a correction, a learning it owes the
issue — silently returns the issue to `open`, where the reconciler re-dispatches it within the
minute. The next session finds an issue at `open` whose last comment says it is blocked, and no
record anywhere says the park was overturned rather than answered. On this project the reconciler
runs every minute, so the window is not theoretical.

It is also self-concealing: the log line reads `answer-resume: human answered, issue returned to
the driver`, which is what an operator would want to see if a human *had* answered.

## Why it is not fixed here

Three readings, and they produce different code:

1. **A PAT is a device.** Stamp `authorDeviceId` (or an actor kind) on PAT-authenticated comment
   writes, so the existing guard catches them. Correct if a PAT in a runner's environment is
   agent agency. Wrong for a person scripting against their own token from a laptop.
2. **A comment cannot resume a park it did not follow.** Ignore a comment whose author is the same
   principal that wrote the park, or that arrives within some window of it. Narrow and local, but
   it makes resumption depend on identity comparison the route does not do today.
3. **A park declares what would resume it.** `needs_info` carries the question; only a comment
   that is a reply to it resumes. Largest change, and the only one that also fixes the case where
   an unrelated human comment wakes a run that was waiting on something else entirely.

Whoever takes this should also decide whether the `cm:guard` above is amended or replaced: it is
currently a correct rule resting on a stale enumeration, which is the shape that reads as checked.

## Honest costs

Every route out of this costs something, and the cheapest one costs the most later.

| Choice | What it takes from whoever adopts it |
|---|---|
| Stamp agency on PAT writes (reading 1) | A person automating against their own token stops being able to answer a parked issue from a script — and gets no error, just silence, which is this same failure pointed the other way. It also spends the meaning of `authorDeviceId`: today it answers *"was this posted by a device"*, and it would start answering *"was this posted by something other than a browser"*. |
| Refuse a resume from the principal that wrote the park (reading 2) | Identity comparison the comment route does not do today, plus one case it gets wrong: a person who parks an issue by hand and then answers their own question no longer resumes it, and nothing tells them why. The smallest change, and the one most likely to be quietly correct for a year and then wrong for someone. |
| Make a park declare what resumes it (reading 3) | A new field on the park, a write path, a migration, and every existing `needs_info` row either grandfathered as "any comment resumes this" or swept. It also puts a shape on `needs_info` that the four other surfaces rendering it have to learn. The only route that also fixes the unrelated case — a human commenting for some other reason, waking a run that was waiting on something else. |
| Do nothing | The park stays a suggestion, and the failure is invisible at the moment it happens because the log line says a human answered. The workaround below is then permanent: one ordering rule every future driver has to know, that no gate enforces and no test can fail on. |

## Workaround until then

Park **last**. Any comment a driver owes the issue goes up before the status write, never after.
