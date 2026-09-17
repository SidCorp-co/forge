# A bounded Sentry pull does not resume where it stopped

**Status:** open residual, bounded and announced in code. No fix proposed here, because resuming a
walk through a list that reorders between ticks is a design decision rather than an implementation
detail.

**Found by:** the second whole-set review of ISS-1085 slice 3, which pointed out that the warning
the pull writes told an operator to "raise the schedule's reach or narrow the query" — and that
neither remedy existed. The message is corrected; the thing it was apologising for is recorded here.

## What is true today

`integrations/sentry/listing.ts` walks Sentry's `Link` cursor to a declared bound of
`SENTRY_LIST_MAX_PAGES` pages at `SENTRY_LIST_DEFAULT_LIMIT` issues each — 1,000 unresolved issues
per target, per tick. Reaching that bound is **not** silent: the listing answers `truncated: true`,
the delivery row records it, and the schedule run's output says so in the operator's own words.

What the next tick does is start again at page one.

Sentry's default issue ordering is by **last seen**. So the issues past the bound are not a random
thousand-and-first — they are the *least recently seen* ones, and they are the same ones on the next
tick, and the one after. A target that consistently holds more than 1,000 unresolved issues above
the admission bar has a tail that this pull can never reach, however many times it runs.

## Why a cursor was not simply persisted

The obvious fix is to store the cursor on the schedule and continue from it next tick. It is wrong
in a way worth writing down, and it was nearly taken:

**The list reorders between ticks.** A cursor is a position in a list ordered by last seen, and
every event Sentry receives between two ticks moves an issue to the front of that list. Resuming
from an hour-old cursor therefore skips every issue that moved across the cursor in the meantime —
and those are, by construction, the ACTIVE ones. A resumable pull would quietly trade "we cannot see
the quiet tail" for "we cannot see some of the busy head", which is a strictly worse silence and a
much harder one to notice.

Making it correct means one of:

1. **Order by something stable** — Sentry's `sort=new` (first seen) rather than last seen. A cursor
   into that list is stable, because an issue's first-seen never changes. The cost is that the walk
   then starts at the oldest issues, so a brand-new error is the LAST thing a pull reaches.
2. **Walk the whole list every tick** and drop the page bound. Honest, and it makes one tick's cost
   a function of somebody else's backlog — which is the thing a bound exists to refuse.
3. **Narrow the question instead of widening the walk.** Ask Sentry for the issues that already
   clear the admission bar (`timesSeen:>=N`), so the list the pull walks is the list it would file
   from rather than everything unresolved. This is the cheapest of the three and the only one that
   makes the bound less likely to be reached at all — but Sentry's search syntax for the
   affected-user count is not the same field the admission gate reads, so it moves part of the gate
   into a query string where nothing tests it.

None of these is obviously right, and the first two change what a tick costs.

## What an operator can do today

Nothing in this file is urgent for a project below the bound, which is every project this fleet
currently has. For one above it: give the binding's target a narrower `projectSlug`, or resolve
issues in Sentry so the list shortens. Both are named in the run's own output.

## Honest costs

**What adopting any of this costs whoever adopts it.**

- **Option 1 (order by first seen)** costs latency on exactly the errors a person most wants filed:
  a new crash is at the end of the walk rather than the start. Budget: half a day to change, and an
  unbounded argument about whether the trade is right.
- **Option 2 (drop the bound)** costs one tick's wall time and one tick's Sentry rate-limit budget,
  both set by how many unresolved issues somebody else's project happens to hold. That is the
  property a bound exists to refuse, so taking it means accepting a schedule whose cost nobody here
  controls. Budget: an hour to change, and a rate-limit incident to find out it was wrong.
- **Option 3 (narrow the query)** costs a second copy of part of the admission gate, in Sentry's
  search syntax, where this repo's tests cannot reach it — and the affected-user half cannot be
  expressed there at all, so the gate would be split across two languages with only one of them
  tested. Budget: two hours to change, and a permanent drift surface.
- **Doing none of them** costs what it costs today: a target above 1,000 unresolved issues has a
  tail this pull never reads. It is announced on every affected tick, in the run record and in the
  delivery row, so it is a known gap rather than a silent one — which is the only reason it is
  acceptable to leave.
- **Whoever takes this** needs one measurement first that nobody here has: how many unresolved
  error-level issues a real target actually holds. Every option above trades against that number,
  and this box has never made a call to a real Sentry.
