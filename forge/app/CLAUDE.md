# Forge Mobile App

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
