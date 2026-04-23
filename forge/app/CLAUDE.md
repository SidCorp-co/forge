# Forge Mobile App

> ⛔ **Paused for v0.x — no development.** See [ADR 0009](../../docs/decisions/0009-mobile-app-paused-for-v0x.md). Code stays in the repo as a learning artefact; do not add features, fix non-critical bugs, or update dependencies. Re-entry criteria are in the ADR.

## Authoritative docs

- Pause decision + re-entry criteria: [ADR 0009](../../docs/decisions/0009-mobile-app-paused-for-v0x.md)
- When mobile resumes (v0.2+), it returns as a **read-only dashboard**, not an execution surface — see ADR 0009 §Decision.

React Native (Expo) cross-platform mobile app for project management and AI chat.

## Architecture

- `src/app/` — Expo Router file-based pages: (auth)/, (main)/ with chat, home, usage, projects, settings
- `src/features/` — Domain modules: agent/, issue/, project/, task/, comment/, usage/
- `src/components/` — Shared UI: chat/, dashboard/, issue/, layout/, ui/, usage/
- `src/hooks/` — Custom React hooks
- `src/lib/` — API client, types, utilities
- `src/providers/` — React Query + Auth context providers

## Key Patterns

- Feature-based organization: each feature has api/, types.ts, components/, hooks/
- React Query for server state, Zustand for client state
- NativeWind (Tailwind CSS) for styling
- Expo Router for file-based navigation
- Same Strapi REST API contract as web/dev

## Recipes

**Add new feature:** 1. Create src/features/<name>/ with api.ts, types.ts, hooks/, components/. 2. Add screen in src/app/(main)/. 3. Wire React Query hooks.

**Add new screen:** 1. Create file in src/app/(main)/<path>.tsx. 2. Use existing feature hooks.

## Commands

- `npm run start` — Expo dev server
- `npm run android` — Android emulator
- `npm run ios` — iOS simulator
- `npm run web` — Web browser
