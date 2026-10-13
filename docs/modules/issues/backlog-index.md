# The backlog indexes: an ordering and a neighbour sweep held between calls

`GET /api/projects/:id/backlog/ranking` and `GET /api/projects/:id/backlog/neighbours` answer from
stored rows. A call computes nothing over the backlog: it drains what changed since the last call,
checks the stored rows cover every issue they should, and reads. The code is
`packages/core/src/issues/backlog/` (the reads `packages/core/src/issues/backlog/rank-read.ts:readRanking` and
`packages/core/src/issues/backlog/alike-read.ts:readNeighbours`; the maintainers
`packages/core/src/issues/backlog/rank-maintainer.ts:drainRank` and
`packages/core/src/issues/backlog/alike-maintainer.ts:drainAlike`). The two
streams of INPUTS (`/backlog/ordering`, `/backlog/alike`, ISS-1173) are unchanged and stay for a
caller that wants the inputs.

## Where a project's weights live

In the project's pipeline config, under `rank`. The built-in table is
`packages/core/src/issues/backlog/rank-weights.ts:BUILT_IN_RANK_WEIGHTS`; a project overrides one weight at a time, and the
override is folded over the built-in table by `foldRankWeights`.

- Write it through the one door every pipeline config key uses (`forge_config`, or `PATCH` on the
  project's pipeline config). The patch replaces `rank` as a whole, as it does every key.
- The write is refused by name for a key the table does not hold, a row a table does not hold, a
  value that is not a number, and for the two retired keys below.
- The server reads no settings file, and a settings file on someone's disk is not a source of
  weights. A client that holds a `rank` object in its own settings file owes the project one of two
  things: move it into the pipeline config, or refuse by name. It must not drop it silently, which
  is the failure this design exists to avoid.
- `rank.module` rows name modules the project defines. A key naming none makes the ranking read
  refuse (`RANK_WEIGHTS_REFUSED`) and name the key, rather than score nothing by it.

`rank.windowCap` and `rank.readCap` are retired: they bounded how many bodies one client pass read,
and the ordering is read from an index that reads no bodies. Sending either is refused by name.

## What a read answers, and what it refuses

The ranking answers `order` (best first, each row with its score broken into parts, `chained`,
`eligible`, `blockedBy`, and the lease it carries), `takeable`, `eligible`, the `weights` in force
and whether they are the project's, `index`, `edges: 'tracker'` and `excluded`.

| It says | When |
|---|---|
| `index.state: 'stale'` with `pending` and `oldestPendingAt` | a change was made that the stored rows have not caught up with, after the read spent its `catchUpMs` budget (default 5000, at most 30000) |
| `index.lapsed` | a stored score walked a blocking edge that has since expired |
| `409 RANK_INDEX_INCOMPLETE` | a takeable issue has no score under the weights in force; names how many, which, and how many are under previous weights. No ordering is served over part of a backlog |
| `409 ALIKE_INDEX_INCOMPLETE` | an unsettled issue has no neighbour set measured now |
| `409 RANK_WEIGHTS_REFUSED` | the stored table cannot rank, with the key at fault |

A read catches up first, then answers every statement of the answer from one repeatable-read
snapshot (`packages/core/src/issues/backlog/rank-read.ts:readRanking`, `packages/core/src/issues/backlog/alike-read.ts:readNeighbours`), so a change committed in the
middle of a read cannot leave the coverage check, the pending count and the rows disagreeing while
the answer says `fresh`.

Age is the one term a clock moves, so it is not stored: it is added at read from `created_at` and
`rank.agePerDay` / `rank.ageCap`. Whether a live `blocks` edge holds an issue back is read live too
(`packages/core/src/issues/live-blockers-sql.ts`, held to the master's own admissibility rule by a
parity test), and the lease is reported on the row, never a reason to omit it.

## What the server does not score, and says so

`excluded` names two things the caller still owes. `reading` is read off one checkout's review
mark, which no server can see; the caller adds `weights.value.reading` itself. Prose edges, a
dependency sentence in an issue body, are a claim the tracker does not hold; only tracker `blocks`
edges are chained and gate. `rank.similarity` and `rank.batchCap` are carried in the table so a
project has one home for it; batch formation stays the client's.

## How it is kept current

Postgres triggers, not application events, mark what changed (a mark for a project that is being deleted is dropped, so a project delete cascades cleanly) in `backlog_index_dirty`, so a writer
that emits no event still marks it: `issues` (status, priority, category, complexity,
reopen_count, created_at, archived_at, title, insert, delete), `issue_dependencies` (`blocks`
edges), `issue_labels`, module `labels`, the project's `rank` weights, `memories` of source
`issue`, and `memory_chunks`. A mark names a subject and carries a generation; a drain deletes only
the generation it read, so a change that lands mid-drain is not lost. A weight or module change
marks the whole project (the all-zero subject).

- A ranking drain rescores the changed issue and every issue above it in a `blocks` chain, and
  removes the row of one that left the takeable set.
- A neighbour drain re-embeds one title when it changes, and re-searches only the seeds a changed
  issue memory can enter or already appears in (`packages/core/src/issues/backlog/alike-maintainer.ts:seedsAffectedBy`: a listed
  hit, a cosine at or above the seed's lowest kept score, or a seed that kept fewer than ten).
- A neighbour drain measures at most `ALIKE_SEEDS_PER_PASS` seeds and marks the rest, so a
  whole-project mark (a new project, a changed embeddings model) is drained over several passes. A
  read's `catchUpMs` budget is honoured between seeds and between passes: it bounds the work
  between provider calls, not one call, and a single embedding call of at most that many titles
  runs under the embedding client's own timeout and retries.
- Archiving or restoring an issue marks it as a neighbour target, so seeds that list it are
  searched again.
- Each drain is one transaction under a Postgres advisory lock per project and index.
- `packages/core/src/issues/backlog/index-sweeper.ts` (pg-boss queue `backlog-index.maintain`, every minute) drains projects nobody
  is reading, so the indexes converge unread.
- The neighbour index is measured with a model, recorded as `measured_with`; a changed
  `EMBEDDINGS_MODEL` makes every seed uncovered and the read refuses until it is re-measured.

## Rolling back

Additive: no existing column or row changed. Reverting the code is enough, and the migration may
stay. To remove it as well:

```sql
DROP TRIGGER IF EXISTS backlog_index_issues_insert_delete ON issues;
DROP TRIGGER IF EXISTS backlog_index_issues_update ON issues;
DROP TRIGGER IF EXISTS backlog_index_edges_changed ON issue_dependencies;
DROP TRIGGER IF EXISTS backlog_index_issue_labels_changed ON issue_labels;
DROP TRIGGER IF EXISTS backlog_index_labels_changed ON labels;
DROP TRIGGER IF EXISTS backlog_index_projects_rank_weights ON projects;
DROP TRIGGER IF EXISTS backlog_index_memories_insert ON memories;
DROP TRIGGER IF EXISTS backlog_index_memories_update ON memories;
DROP TRIGGER IF EXISTS backlog_index_memories_delete ON memories;
DROP TRIGGER IF EXISTS backlog_index_memory_chunks_changed ON memory_chunks;
DROP FUNCTION IF EXISTS backlog_index_issue_changed(), backlog_index_edge_changed(),
  backlog_index_issue_label_changed(), backlog_index_module_label_changed(),
  backlog_index_rank_weights_changed(), backlog_index_memory_changed(),
  backlog_index_memory_chunk_changed(), backlog_index_mark(text, uuid, uuid, text);
DROP TABLE IF EXISTS issue_alike_hits, issue_alike_seeds, issue_rank_scores, backlog_index_dirty;
```

## The client half

The CLI half (`forge next`, `forge alike`, in github.com/SidCorp-co/forge-plugin) is a separate
change in that repository, reported from ISS-1336 and not made here: it reads these two routes,
pushes or refuses by name a settings-file `rank` object, drops `windowCap` / `readCap`, adds its
own `reading` term, and treats prose edges as client-side advice.
