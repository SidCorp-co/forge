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

Three places still impose the ordering by hand, each naming the 2026-09-23 race as the reason:

- `packages/core/Dockerfile`
- `packages/web-v2/Dockerfile`
- `.github/actions/setup-workspace/action.yml`

That is three copies of one fact, which is the shape this repo treats as a defect rather than a
convention.

## Why the declaration exists, and why it reads as wrong

`packages/contracts`'s own `description` field says **"Type-only surface — no runtime coupling."**
It re-exports Drizzle row types and request types from core, and every import of `@forge/core` under
`packages/contracts/src` (`admin.ts`, `integrations.ts`, `requests.ts`, `rows.ts`, `ssh-keys.ts`,
`body-components.ts`) is an `import type` or `export type`. `src/document-patch.ts` has **zero
imports**.

So the declaration and the description already disagree, and the code agrees with the description.

## What is not established

- Whether moving `"@forge/core"` to `devDependencies` in `packages/contracts` is safe for
  `packages/web-v2`. A few of contracts' exports (the root `.` among them) still point at
  `./src/*.ts`, and those files import core for types; a bundler erases type imports, but
  `pnpm deploy --prod` of web-v2 has not been tested against that change. **Untested — do not assume
  either direction.**
- Whether any consumer imports a *value* from `@forge/contracts` that transitively needs
  `@forge/core` at runtime. Nothing has scanned for it.

## Honest costs

| Choice | What it costs whoever adopts it |
|---|---|
| Leave the cycle, keep the three hand-written orderings | Turbo warns on every run, and the three orderings keep stating a reason the emit-only builds no longer have. `pnpm verify` runs no docker build, so nothing here can gate either. |
| Move `"@forge/core"` to `devDependencies` in `packages/contracts` | One line to write, and a validation that has to be bought before the answer is known: a `pnpm deploy --prod` of `packages/web-v2` plus a real `next build`, because web-v2 consumes contracts' `./src/*.ts` exports and those import core. If a consumer turns out to need core at runtime, the line comes back and the work is spent. |
| Remove an ordering early, on the argument the race is gone | Cheap, and only safe once it is established that no consumer type-checks against contracts' `dist` in the same invocation that builds it. Keep all three until that is read. |
