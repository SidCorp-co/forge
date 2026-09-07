# pg-boss 12 needs a staged deploy, and nobody has scheduled one

- Status: **blocked on a human decision about deploy sequencing.** The bump is reverted on `main`; nothing is scheduled.
- Owner: unassigned. Raised 2026-09-07 by the ISS-963 driver, which measured the outage.
- Related: `packages/core/src/queue/boss.ts` (the pin and its guard) · PR #317 (the bump) · CHANGELOG entry for the revert

## What happened

Dependabot's majors group (#317) took `pg-boss` from `10.4.2` to `12.30.0`. Every gate passed: 15
conformance checks, 5,825 unit tests, 1,167 integration tests, the build, and CI on two separate
PRs. It reached forge-beta on 2026-09-07 at 22:02 UTC and the API container never came up. The
proxy answered `no available server` — HTTP 503 on every route, including `/health` — for 40
minutes, which is as long as it took to find the cause, because the tracker that would have carried
the report is the service that was down.

Reproduced locally against a database at the schema version forge-beta holds:

```
AssertionError [ERR_ASSERTION]: Cannot migrate pg-boss schema from version 24:
the oldest supported starting version is 25. Upgrade to a schema at or above
that version using an older pg-boss release first.
    at Contractor.start (node_modules/pg-boss/dist/contractor.js:43:28)
    at async startBoss (packages/core/dist/queue/boss.js:45:5)
```

pg-boss 10.4.2 leaves the schema at **24**. pg-boss 12 refuses to start below **25**. The two are
not deployable in sequence, and `boss.start()` runs before the server listens, so the refusal is
total rather than a degraded queue.

## Why no test could have caught it

Every suite builds its database from `drizzle/migrations` into a fresh schema, where pg-boss
installs its own tables at whatever version the installed release wants. **The failing state — an
existing schema at 24 — exists only in a deployed environment.** A green suite here is evidence
about a proposition the runtime cannot represent, which is the case `CLAUDE.md` names under *Green
is a claim about one proposition*.

## What is on `main` now

`pg-boss` is pinned to `^10.4.2` and `queue/boss.ts` is back to the default import (v11 and v12
export `PgBoss` as a named export; v10 does not). The pin carries a `cm:guard` naming the version
floor and pointing here. Nothing else from #317 was touched — the other 16 updates stand.

**The price, stated:** the queue stays two majors behind, and every future Dependabot majors group
will re-propose the same bump and pass the same gates. This is a workaround with an exit condition,
not a decision.

## What a human has to decide

The upgrade path pg-boss documents is *deploy an intermediate release first*: v11 moves the schema
24 → 25, and v12 then starts. That is **two deploys of the API in sequence, on a shared
environment**, with the first one carrying nothing but the migration:

1. `pg-boss@^11`, default import unchanged, deploy, confirm `select version from pgboss.version`
   reads 25 or above.
2. `pg-boss@^12`, switch to the named import, deploy.

Neither step is hard. What is not the driver's to choose is **when a shared environment takes two
API restarts back to back**, and whether the same sequence is run against production first or last.

## Honest costs

- **Staying on 10 costs currency.** The queue is two majors behind, and every Dependabot majors
  group will re-propose the bump and pass every gate, so somebody re-reads this page each time. The
  `cm:guard` on `queue/boss.ts` is what makes that reading cheap; there is nothing that makes it
  automatic.
- **Taking the upgrade costs two restarts of a shared API, in sequence.** The first carries no
  feature at all — it exists to move `pgboss.version` from 24 to 25. On a box where agents are
  mid-run, that is two windows in which `boss.send` has no server, not one.
- **Either way, the gates stay blind to it.** The failing state cannot be built from
  `drizzle/migrations`, so no suite in this repo will ever go red on it. The startup check in the
  section below is the only thing that converts it from a proxy 503 into a sentence, and it is not
  written yet.
- **Doing nothing costs the next deployer 40 minutes**, measured — that is how long it took to get
  from `no available server` to the assertion, with the tracker that would have carried the report
  being the service that was down.

## What would stop this recurring

A startup check that reads `pgboss.version` and refuses by name — *"pg-boss schema is 24, this
release needs 25; deploy pg-boss 11 first"* — before `boss.start()` reaches the assertion, so the
next person sees the sentence in a log rather than inferring it from a proxy 503. That belongs with
whoever takes the upgrade, because it is the same reading of the same table.
