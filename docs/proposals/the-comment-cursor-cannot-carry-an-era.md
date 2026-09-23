# The comment cursor cannot carry an era, and the fix is a wire-format change

Found by ISS-1173's page-boundary repair, which was looking for other keyset pagers over a
`timestamptz` column and turned this one up. Not fixed there: the fix changes a token this API has
already shipped to clients, which is a decision that issue does not get to take.

## What the two pagers now do differently

`packages/core/src/issues/backlog/page-read.ts:CURSOR_AT` and
`packages/core/src/comments/service.ts:cursorKeyExpr` are the same idea — read `created_at` as
microsecond text so a cursor can represent the value it is compared against — spelled differently:

- the backlog one formats `'YYYY-MM-DD"T"HH24:MI:SS.US"Z" BC'`, era included;
- the comment one formats `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`, era omitted.

Measured against Postgres: `to_char` on `0001-01-01 00:00:00 BC` with the era omitted prints
`0001-01-01T00:00:00.000000Z`, which casts back to the same instant **AD**. A page boundary landing
on such a row resumes about four thousand years away from where it stopped. The same call on
`infinity` answers NULL for either spelling.

## Why the two-character fix does not apply here

`packages/core/src/comments/cursor.ts:decodeCommentCursor` validates the timestamp half of the
token with `Date.parse`. `Date.parse('2026-05-11T08:13:11.245678Z AD')` is `NaN`, so adding the era
to `cursorKeyExpr` would make every comment cursor this endpoint mints refuse itself on the next
page. The era cannot be added without changing what the token carries, and the token is base64 in
clients' hands today.

That is a wire-format decision with a migration behind it — accept both shapes for a window, or
version the token — and it belongs to whoever owns the comment thread API rather than to a fix of
the backlog stream's pager.

## What is and is not at risk

Nothing reaches it through the product. `comments.created_at` and `issues.created_at` are both
`defaultNow()`, every explicit write passes a JavaScript `Date`, and a `Date` can hold neither a BC
instant nor an infinity. The exposure is a hand-written `INSERT` or a restore that carries one. The
backlog pager was fixed anyway because the cost there was one token in a file already being
changed; here the cost is a shipped format.

`infinity` is the sharper half, and the two differ there on purpose. The backlog pager refuses it by
name — `UNPAGEABLE_TIMESTAMP`, naming the issue — because paging from a NULL cursor reads zero rows
and ends the stream reporting itself `complete` over everything behind it. The comment pager has no
such guard, but a NULL `cursorKey` reaches `encodeCommentCursor` as the string `null` and the next
page's `'null'::timestamptz` raises, so it fails loudly rather than answering short. That is why it
is recorded here rather than carried as the same defect.

## Honest costs

The price of doing this, not of leaving it:

| Cost | What it takes |
|---|---|
| A token clients hold has to change | The era cannot go into `cursorKeyExpr` alone. `decodeCommentCursor` has to accept both spellings for a window, or the token has to carry a version byte, and either way a cursor minted before the change and replayed after it is a case somebody has to decide about rather than discover. |
| A test that cannot be written from the product | Nothing that writes a comment can produce a BC `created_at`, so the case is planted with raw SQL. That is the same shape as ISS-1173's own boundary tests, and the same objection applies to it: the reproduction proves the pager, not that anything reaches the pager this way. |
| It buys nothing anyone has hit | No comment in any deployment carries a BC or infinite `created_at`, and no writer can make one. This is a spelling made consistent before it is needed, which is the only moment it is cheap and also the hardest moment to justify spending a round on. |
| Two spellings meanwhile | Until it is taken, `page-read.ts` and `comments/service.ts` hold visibly different formats for one idea, and a reader comparing them has to find this file to learn which is right and why. That is the cost of recording it here instead of fixing it. |
