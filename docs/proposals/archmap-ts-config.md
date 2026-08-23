# archmap cannot see web-v2's imports

`arch check` is the relations gate. On `packages/web-v2` it currently measures
almost nothing, and three declared contracts sit at `draft` because of it.

## Measured 2026-08-23

`arch check --stats` on this repo:

| | |
|---|---|
| edges resolved | 4,295 |
| edges unresolvable | 997 |
| of those, from `packages/web-v2` | 841 |

The 841 are one thing — the `@/*` tsconfig alias web-v2 imports through:

```
@/features  265    @/design  260    @/lib  250    @/providers  51
```

`packages/core` uses relative paths, so it is unaffected; web-v2 uses the alias
everywhere, so effectively the whole package's graph is invisible. A `forbidden`
contract over web modules can only catch a relative-path violation, which nobody
writes there.

## Cause

`src/providers/ts.mjs` invokes dependency-cruiser with `--no-config` and no
`--ts-config`, so its resolver never reads `compilerOptions.paths`.

## Proven fix

Same tree, same tool, run from the package directory with the flag:

```
node node_modules/dependency-cruiser/bin/dependency-cruise.mjs src \
  --output-type json --no-config --ts-pre-compilation-deps \
  --ts-config tsconfig.json --do-not-follow node_modules
```

→ **1,795 edges resolved, 15 unresolvable** (14 `@forge/contracts`, 1 `mermaid`).

Two details the flag needs, both found by running it:

1. The tsconfig's `include` globs are relative to the tsconfig, so the cruise
   must run with `cwd` = the package. From the repo root the same command dies
   with `TS18003: No inputs were found in config file`.
2. Which means one `--ts-config` per package, not one for the repo.

## What this blocks

On the alias-resolved graph all three web contracts measure 0 edges, so they are
lockable the day archmap can see them:

| contract | edges |
|---|---|
| `web-design-is-presentational` (design → features) | 0 |
| `web-design-holds-no-api-client` (design → lib-api) | 0 |
| `web-features-do-not-reach-into-routes` (features → app) | 0 |

The third read 2 until `coreFileUrl` moved out of `lib/api/client.ts` — a real
violation the gate could not have reported.

## Not the fix

- A second checker beside `arch check`. Relations has one owner; two configs of
  the same rule drift apart, which is the reason this repo has no ESLint.
- Patching `.forge/archmap/`. It is `@generated ... do not edit` and
  `arch install --force` re-vendors it, so the patch would disappear on an
  upgrade PR — a rule a re-freeze can silently drop is not a rule.
