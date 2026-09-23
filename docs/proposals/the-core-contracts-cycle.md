# @forge/core and @forge/contracts declare each other, so nothing can order their builds

Found while repairing CI on 2026-09-23, not fixed there: removing the cycle means deciding whether
`@forge/contracts` may declare `@forge/core` at all, which is ISS-1170's surface, and the repair was
made while `main` was red.

`packages/core/package.json` holds `"@forge/contracts": "workspace:*"` in `dependencies`.
`packages/contracts/package.json` holds `"@forge/core": "workspace:*"` in `dependencies`. Turbo says
so on every run it is asked to order them:

```
WARNING  Circular package dependency detected: @forge/core, @forge/contracts
```

## What the cycle costs

**There is no topological order between the two packages**, so any command that builds one "and its
workspace deps" may run both concurrently. `packages/core`'s `tsc` can then observe
`packages/contracts/dist` half written — the `.js` emitted and the `.d.ts` not — and fail:

```
src/pipeline/pipeline-config-service.ts(9,8): error TS7016: Could not find a declaration file for
module '@forge/contracts/document-patch'. '/repo/packages/contracts/dist/document-patch.js'
implicitly has an 'any' type.
```

Measured: CI run `35815142136` failed the `images` job this way at `43dcdc478`, while the same tree
built both images cleanly on a developer box minutes earlier. **A race reads as a flake and is not
one.** It became reachable only when `document-patch` was repointed at `dist/` on 2026-09-23; before
that every contracts export was raw `.ts` and there was nothing to emit, so the cycle was inert.

Three places now impose the ordering by hand, each naming the same rule:

- `packages/core/Dockerfile` — and there the ordering is only real because the final build dropped
  its `...`; `--filter @forge/core...` would pull `@forge/contracts` back into the same invocation
  and let it build a second time beside core's `tsc`, which is the race again one layer up
- `packages/web-v2/Dockerfile`
- `.github/actions/setup-workspace/action.yml`

That is three copies of one fact, which is the shape this repo treats as a defect rather than a
convention. A fourth consumer that forgets gets a green that depends on scheduling.

## Why the declaration exists, and why it reads as wrong

`packages/contracts`'s own `description` field says **"Type-only surface — no runtime coupling."**
It re-exports Drizzle row types and Zod schemas derived from core, so the dependency is real to
`tsc` and absent at runtime — `src/document-patch.ts` is 178 lines with **zero imports**, and the
`dist/document-patch.js` that ships imports nothing either.

So the declaration and the description already disagree, and the code agrees with the description.

## What is not established

- Whether moving `"@forge/core"` to `devDependencies` in `packages/contracts` is safe for
  `packages/web-v2`. Its remaining exports still point at `./src/*.ts`, and those files import core
  for types; a bundler erases type imports, but `pnpm deploy --prod` of web-v2 has not been tested
  against that change. **Untested — do not assume either direction.**
- Whether any consumer imports a *value* from `@forge/contracts` that transitively needs
  `@forge/core` at runtime. The two known value importers reach `document-patch`, which imports
  nothing; nothing has scanned the rest.
- Whether splitting `document-patch` into a package of its own is cheaper than breaking the cycle.
  Not costed.

Whoever takes this reproduces the race before changing anything — the failing shape is a concurrent
`packages/core build` against a mid-emit `packages/contracts dist`, and a fix that cannot be shown
closing a reproduced failure is a guess with a commit message.

## Honest costs

| Choice | What it costs whoever adopts it |
|---|---|
| Leave the cycle, keep the three hand-written orderings | Cheapest today, and the bill arrives as a race that reads as a flake — green on one machine, red on another, over the same bytes. `pnpm verify` runs no docker build, so nothing here can gate it. |
| Add a fourth consumer without the ordering | A green that depends on scheduling. Invisible until a scheduler makes a different choice, which is how this defect was born. |
| Move `"@forge/core"` to `devDependencies` in `packages/contracts` | One line to write, and a validation that has to be bought before the answer is known: a `pnpm deploy --prod` of `packages/web-v2` plus a real `next build`, because web-v2 consumes contracts' `./src/*.ts` exports and those import core. If a consumer turns out to need core at runtime, the line comes back and the work is spent. |
| Split `document-patch` into its own zero-dependency package | A new workspace package, a lockfile change, an entry in every image that ships it, and two import-site rewrites. Removes the cycle's reason to exist for the only export needing `dist`. Not costed against the row above. |
| Remove an ordering early, on the argument the cycle is gone | How this returns. The orderings are cheap and their absence is invisible until it is not. Keep all three until the chosen fix has landed and been reproduced against. |
