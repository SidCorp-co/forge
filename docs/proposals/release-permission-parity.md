# Three release surfaces, three different answers about who may release

**Status:** open residual, recorded 2026-08-26. Pre-existing since `db9b9fa3` (the server side landed
without a client side); not caused by and not fixed in `14668ba6`, which rebuilt the panel's rendering
and left the permission question exactly where it was.

## The asymmetry

The server has one rule. `packages/core/src/release-batch/routes.ts`:

```
assertProjectRole(access, 'admin');
```

The three surfaces that call `POST /api/projects/:projectId/release-batches` disagree with it and with each other:

| Surface | File | Gates on |
|---|---|---|
| issue detail banner | `features/issues/components/awaiting-release-banner.tsx` | `canWrite`, i.e. `projectRole !== "viewer"` — a **member** passes |
| dashboard card | `features/project-dashboard/components/awaiting-release-card.tsx` | nothing |
| issues-page panel | `features/issues/components/release-gate-panel.tsx` | nothing |

So a **member** is shown a live "Release now" / "Release N" button on all three, clicks it, and gets a
403 toast. A viewer is stopped on one surface out of three. The button is not disabled, carries no
`title` explaining why, and the only feedback is the failure.

`canWrite` is not a near-miss for `admin` — it is the wrong axis. Every other write on the issue detail
screen is correctly a member-level action; releasing is the one that is not, and it inherited the
screen's prop because that prop was in scope.

## Why this is not a UI patch

Fixing it per surface reproduces the same drift one level down: three components each deciding what
`admin` means, against a server rule none of them import. The shape that closes it is one hook —
`useCanRelease(projectId)` — resolving the role once from `projectsQ` and consumed by all three, with
the disabled button carrying its own reason in `title` (the pattern `14668ba6` already established on
the panel's Release button for the empty-selection case).

**Closing condition:** one `useCanRelease` hook, all three surfaces consuming it, and a test per surface
that a non-admin sees a disabled control with a stated reason rather than a button that 403s.

## Not decided here

Whether `admin` is the right server rule at all. If releasing should be a member-level action, the
fix is one line in `routes.ts`'s `assertProjectRole(access, 'admin')` and this proposal collapses to
"delete the `canWrite` prop from the banner". That is a permissions decision, not a frontend one,
and it belongs to the maintainer.

## Honest costs

- **The fix removes an affordance rather than adding one.** Members who see a Release button today
  stop seeing an enabled one. That is correct — it 403s — but it is a capability disappearing from
  three screens, and the people it disappears for did not experience the bug as their problem.
- **One hook is one shared point of failure.** `useCanRelease` resolving the role once means a wrong
  read breaks all three surfaces together instead of one, and every new release surface inherits the
  dependency.
- **It may be spent on the wrong side.** If the maintainer decides releasing is a member-level
  action, one line in `routes.ts` settles it and the hook plus its three tests are work done to
  enforce a rule that no longer exists.
