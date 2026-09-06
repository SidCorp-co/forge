# The device token is retired from the data plane; the control plane still has its own species

- Status: **residual of ISS-927, not started.** The data-plane half shipped there. This is the other
  half, and it is not a diff — it needs a human at every paired box.
- Owner decision it implements: 2026-09-06, *"the device token is retired, not kept alongside. The
  daemon authenticates with the same token form as everything else."*
- Related: `packages/core/src/auth/deviceToken.ts` · `packages/core/src/middleware/require-device.ts`
  · `packages/runner/crates/forge-runner-core/src/auth/cred_store.rs`

## What ISS-927 did retire, so this is read against the right baseline

`requireAnyAuth`'s device branch — the ONE place a device token bought its owner's whole account
(`c.set('userId', device.ownerId)`). It is gone, and with it the reason the caller class needed it:
a job holds `job:<id>` from the moment it is claimed, an unattended session holds `session:<id>`
from `agent:start`, and both die with the work they were minted for.

So no device token reaches the data plane any more. What remains is narrower than the owner's
sentence and worth stating precisely: the device still has **its own credential species on the
control plane** — a base64url secret with a bespoke argon2 verifier, distinct from
`forge_pat_<env>_<64hex>` and verified by different code.

## What is left, and what it would take

`verifyDeviceToken` is reached from four middlewares across roughly thirty route mounts
(`/api/devices/*`, `/api/jobs/*` device siblings, `/api/skills/:projectId/skills/sync`, the
agent-sessions dual-auth pair) plus the `/ws` handshake. The shape of the change is small:

1. Pairing mints a PAT named `device:<deviceId>` instead of writing `devices.token_hash` —
   insert the device row first, then mint, because the name needs the id.
2. `device:` joins `MACHINE_TOKEN_NAME_PREFIXES`, which is the whole of what the PAT cap, the
   hand-mint refusal and the `agency` stamp need. That array is why this step is one line.
3. `verifyDeviceToken` becomes: `isPatLike` → `verifyPat` → resolve `device:<uuid>` to its row.
   The four middlewares and the WS handshake keep their current shapes and their current
   `userId`-left-unset semantics; only the verifier underneath changes.
4. `devices.token_hash` / `token_prefix` are dropped. Code that ships beside the thing it replaced
   leaves two live paths and a reader who cannot tell which one runs.

The Rust runner very likely needs **no change at all**: `cred_store` treats the token as an opaque
string, and pairing hands back whatever plaintext core minted. That is the property that makes the
`gh` pattern attractive here, and it should be verified rather than assumed before anyone starts.

## Why it is not in ISS-927's diff

**Every paired box stops authenticating the moment it deploys, and re-pairing needs a human at each
machine.** `forge-runner pair <code>` is interactive; there is no remote re-pair. The fleet this
would sever serves ~20 tenant projects and includes the box that would have to fix it — a `drive`
job cannot re-pair the runner it is running on.

That is not a reason to keep a fallback. It is a reason this is an operation with a rollout, not a
change with a merge: cut the release, then re-pair boxes in a window someone is watching.

## Honest costs

| Cost | Detail |
|---|---|
| A dual-accept window is the alternative, and it is the thing the owner refused | Accepting both forms behind a `cm:hack` with an exit condition would let the fleet upgrade in either order and cost nothing at the door. It is refused because *"kept alongside"* is how the two-species state became permanent the first time. If this is ever reconsidered, it must carry a dated exit condition and a query that proves every device row has migrated — not a note |
| The argon2 verifier is not dead code the day this lands | `verifyDeviceToken` is also how `/ws` authenticates. Dropping the columns and the verifier in one commit is correct; dropping the columns while a code path still reads them is a 500 on the handshake, which reads to an operator exactly like a network fault |
| One credential form is a claim this only half-earns until then | ISS-927 can honestly say a caller reaches the API with one token form. It cannot say Forge has one credential species, and no comment in the tree should be written as if it does |
| Nobody is assigned this | It is a residual with an owner decision behind it and no issue, which is deliberate — filing it as a `draft` nobody browses would be the `file-instead-of-fix` red flag wearing a different hat. It becomes an issue when someone schedules the re-pair window, and that decision is a human's |
