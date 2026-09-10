# A PAT permission is as coarse as its mount, and `projects:read` is nearly everything

- Status: **found by walking ISS-973's acceptance criteria on forge-beta, 2026-09-10.** Not a
  regression and not a blocker for ISS-973 — recorded here because it is out of that row's reach
  and is the first thing an operator will hit.
- Related: `packages/core/src/auth/pat-permissions.ts` (`PAT_PERMISSION_RESOURCES`,
  `patResourceForPath`) · `scripts/check-pat-surface.mjs` · ISS-972 phases 3–6.

## What was measured

On forge-beta at `b32bdc2d`, a token granted exactly `issues:read`:

| Request | Answer |
|---|---|
| `GET /api/issues/<id>` | `200` — the route answered |
| `GET /api/projects/<id>/issues` | `403 PAT_PERMISSION_REQUIRED`, wanted `projects:read` |

Both read issues. The second is the route the web UI and most callers actually use, because the
flat `/api/issues` mount serves a single issue by id and has no list route.

## Why

The menu maps a resource to `/api/...` **mount prefixes**, and `patResourceForPath` answers with
the resource owning the matched prefix. `/api/projects` is one prefix and the project-scoped
router mounted there serves issues, schedules, knowledge, members, jobs, metrics and more. So the
attribution is mount-shaped rather than subject-shaped, and two consequences follow:

1. **`projects:read` is a near-universal read grant.** Anything reachable under
   `/api/projects/:id/*` is inside it, which is most of the project-scoped API. A token narrowed
   to `projects:read` is barely narrowed.
2. **`issues:read` does not mean "can read issues".** It covers the four flat mounts
   (`/api/issues`, `/api/comments`, `/api/attachments`, `/api/labels`) and nothing under
   `/api/projects/:id/`. The name promises a subject; the grant delivers a mount.

The second is the affordance defect. Nothing is *wrong* — the fence refuses correctly and names
the permission it wanted, so an operator recovers in one read of the error — but the name leads
them somewhere the grant does not go.

## Why ISS-973 did not fix it

Changing it means resolving a path to its most specific resource
(`/api/projects/*/issues` → `issues`, `/api/projects/*` → `projects`), which changes the shape of
the declaration itself: `PAT_PERMISSION_RESOURCES` becomes patterned rather than prefixed, the
16-prefix literal frozen in `pat-permissions.test.ts` no longer describes it, and
`check-pat-surface.mjs` walks routes per prefix and would need the same patterning to keep
proving every route reaches the fence. That is a phase, not a follow-up edit, and ISS-973's own
scope is "the token carries its grants and the request consults them" with the menu taken as
Phase 1 left it.

## What it is not

Not a security hole: the fence is strictly narrower than before for a granted token and
unchanged for an ungranted one, and `fencedProjectIds` still decides which projects regardless of
which groups. The failure mode is an operator granting less reach than they meant, or more, and
finding out from a 403 that names the permission.

## The shape a fix would take

Declare sub-resource patterns alongside mounts, most specific wins:

```
issues: ['/api/issues', '/api/comments', '/api/attachments', '/api/labels',
         '/api/projects/*/issues'],
projects: ['/api/projects'],   // everything under it not claimed above
```

and teach both `patResourceForPath` and `check-pat-surface.mjs` the same precedence, from the
same declaration, so the gate keeps proving the property the menu claims.

## Honest costs

The price of adopting the patterned declaration above, not of the affordance defect it fixes.

| Cost | What it takes |
|---|---|
| The gate's own correctness becomes drift-able | A prefix is a string comparison; a pattern with precedence is a matcher the runtime and `check-pat-surface.mjs` must implement identically. The day they disagree, the gate certifies routes the fence never sees — which that script's own guard calls worse than no gate. |
| The frozen literal stops being readable at a glance | The 16-prefix list in `pat-permissions.test.ts` is what makes a silent reachability widening impossible, and it is a list of strings. Under patterns it becomes (pattern, resource) pairs plus the routes they resolve to: a bigger artefact to read and a slower one to be sure of. |
| It breaks live tokens, once, and the free window is closing | All 17 tokens measured on forge-beta are ungranted, so re-attribution is free today. A token granted `projects:read` after this ships reaches the project-scoped issue list; after the change it would not — a live integration breaking on a deploy, with nothing that would announce it. |
| Doing it properly is a phase, not an edit | Declaration shape, runtime resolver, the gate's walker and the frozen literal all move together, and none of them can move alone without the others certifying something false. |
| Leaving it costs the plain reading of the names | `issues:read` not covering the route callers actually use to read issues teaches the wrong lesson, paid one confused operator at a time. Bounded by the 403 naming the permission it wanted, which is why this was recorded rather than rushed. |
