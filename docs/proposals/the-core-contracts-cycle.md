# @forge/core and @forge/contracts declare each other, so nothing can order their builds

**Removed when:** `@forge/contracts` no longer declares `@forge/core` as a runtime dependency and
turbo prints no cycle warning, which dev ISS-137 carries. The change that lands it deletes this
file.

Found while repairing CI on 2026-09-23, not fixed there: removing the cycle means deciding whether
`@forge/contracts` may declare `@forge/core` at all, which is ISS-1170's surface, and the repair was
made while `main` was red.

`packages/core/package.json` holds `"@forge/contracts": "workspace:*"` in `dependencies`.
`packages/contracts/package.json` holds `"@forge/core": "workspace:*"` in `dependencies`. Turbo says
so on every run it is asked to order them:

```
WARNING  Circular package dependency detected: @forge/core, @forge/contracts
```

## What the cycle cost, and what it costs now

**There is no topological order between the two packages**, so any command that builds one "and its
workspace deps" may run both concurrently. On 2026-09-23 that was a race: `packages/core`'s
type-checking `tsc` could observe `packages/contracts/dist` half written — the `.js` emitted and the
`.d.ts` not — and fail with `TS7016` on `@forge/contracts/document-patch`. CI run `35815142136`
failed the `images` job that way at `43dcdc478`, while the same tree built both images cleanly on a
developer box minutes earlier.

Since `452be8dce` both builds are emit-only (`tsc … --noCheck` in each package's `build` script), and
the typecheck configs map `@forge/contracts` to `src/`, so core's build no longer reads contracts'
`dist` declarations and the `TS7016` above has no reader to fail in. The race as measured is not
reproducible in that shape on dev; what remains is a cycle with no order, which turbo reports on
every run.

Three places still impose the ordering by hand:

- `packages/core/Dockerfile`, which names the 2026-09-23 race as its reason;
- `packages/web-v2/Dockerfile` and `.github/actions/setup-workspace/action.yml`, which name a
  different one: contracts' export map points at `dist/`, which a checkout does not hold, so it has
  to be built before anything resolves `@forge/contracts/<module>`.

The last two stand without the cycle; the first is the one that stands only because of it.

## Why the declaration exists, and why it reads as wrong

`packages/contracts` re-exports Drizzle row types and request types from core, and every import of
`@forge/core` under `packages/contracts/src` (`admin.ts`, `integrations.ts`, `requests.ts`, `rows.ts`,
`body-components.ts`) is an `import type` or `export type`. `src/document-patch.ts` has **zero
imports**. Its own `description` now reads "Shared types and runtime tables … row and request types
derived from @forge/core", so it no longer claims to be type-only, but nothing it carries at runtime
comes from core: the emitted `dist/*.js` holds no `@forge/core` import, and five `dist/*.d.ts` do.

So core is a dependency of contracts' declarations, not of its runtime, and `dependencies` says the
second.

## What is not established

- Whether moving `"@forge/core"` to `devDependencies` in `packages/contracts` is safe for
  `packages/web-v2`'s image. Every export now points at `dist/`, and web-v2's `next build`
  type-checks against those five `.d.ts`, which name `@forge/core/public` and
  `@forge/core/admin-types`; whether `pnpm install --filter web-v2...` still links core for them
  once it is a dev dependency has not been run. **Untested — do not assume either direction.**

## Honest costs

| Choice | What it costs whoever adopts it |
|---|---|
| Leave the cycle, keep the three hand-written orderings | Turbo warns on every run, and core's Dockerfile keeps stating a reason the emit-only builds no longer have. `pnpm verify` runs no docker build, so nothing here can gate either. |
| Move `"@forge/core"` to `devDependencies` in `packages/contracts` | One line to write, and a validation that has to be bought before the answer is known: a web-v2 image build with a real `next build`, because contracts' declarations name core's types. Its runtime cannot need core (the emitted `.js` imports none of it); if the type resolution fails, the line comes back and the work is spent. |
| Remove an ordering early, on the argument the race is gone | Cheap, and only safe once it is established that no consumer type-checks against contracts' `dist` in the same invocation that builds it. Keep all three until that is read. |
