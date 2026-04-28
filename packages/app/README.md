# app

> ⛔ **Paused for v0.x — no active development.**
> See [ADR 0009](../../docs/decisions/0009-mobile-app-paused-for-v0x.md) for the decision and the re-entry criteria. Code stays in the repo as a learning artefact; please don't add features, fix non-critical bugs, or update dependencies. Issues filed against `packages/app` will be closed as `wontfix` until v0.2+.

React Native (Expo) cross-platform mobile app — when development resumes (v0.2+), it returns as a **read-only dashboard** for project status and chat, not an execution surface. See [ADR 0009 §Decision](../../docs/decisions/0009-mobile-app-paused-for-v0x.md) for scope.

## Why paused

Short version: maintaining four UI clients (web, dev, app, widget) at v0.1 alpha velocity was producing inconsistent surfaces. Mobile parity is deferred until the core contract stabilises.

Longer version is in [ADR 0009](../../docs/decisions/0009-mobile-app-paused-for-v0x.md).

## If you must run it (read-only exploration)

```bash
cd packages/app
npm install        # NB: not part of the pnpm workspace
npm run start      # Expo dev server
```

| Script | Purpose |
|---|---|
| `npm run start` | Expo dev server (QR for device, web, simulators) |
| `npm run ios` | iOS simulator |
| `npm run android` | Android emulator |
| `npm run web` | Browser preview |

The codebase still talks to core's REST contract — but cross-app parity is **not** a concern for active development. If you change `packages/core` or `packages/contracts`, you may break this package. That's expected for now.

## Architecture (frozen at pause)

- `src/app/` — Expo Router file-based pages: `(auth)/`, `(main)/` with chat, home, usage, projects, settings
- `src/features/<domain>/` — per-feature api/types/components/hooks (agent, issue, project, task, comment, usage)
- `src/components/` — shared UI: chat, dashboard, issue, layout, ui, usage
- `src/providers/` — React Query + Auth context
- NativeWind (Tailwind) for styling, Expo Router for navigation, Zustand for client state

## Re-entry checklist

Before resuming development, satisfy the criteria in [ADR 0009](../../docs/decisions/0009-mobile-app-paused-for-v0x.md). At a minimum: core contract is stable, `@forge/contracts` is consumable from RN, and the read-only dashboard scope is signed off.
