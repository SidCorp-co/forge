# Forge Web App

Next.js App Router cloud UI for project management, issue tracking, and AI chat.

## Architecture

- `src/app/` — App Router pages (auth, projects, settings, usage)
- `src/features/` — Domain modules: issue/, project/, task/, comment/, agent/, usage/
- `src/components/` — Shared UI: chat/, issue/, common/, layout/, ui/
- `src/lib/` — API client, types, constants, utils, validations (Zod)
- `src/providers/` — React Query + Auth context providers

## Key Patterns

- Feature-based organization: each feature has api/, types.ts, components/, hooks/
- React Query for all server state (`@tanstack/react-query`)
- Tailwind CSS + Lucide icons for styling
- WebSocket subscription for real-time chat streaming
- Protected routes via middleware.ts

## Recipes

**Add new feature:**
1. Create `src/features/<name>/` with api.ts, types.ts, hooks/, components/
2. Add page in `src/app/(protected)/<name>/`
3. Add React Query hooks wrapping API calls

**Add new page:**
1. Create route in `src/app/(protected)/<path>/page.tsx`
2. Use existing feature hooks for data fetching

## Commands

- `npm run dev` — Dev server (port 3000)
- `npm run build` — Production build
