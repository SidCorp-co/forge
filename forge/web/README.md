# web

Next.js 16 cloud UI for Jarvis Agents — project dashboard, issue pipeline, agent chat, settings. Talks to [`@forge/core`](../core) over REST + WebSocket and shares row/request types via [`@forge/contracts`](../contracts).

## Prerequisites

- **Node** `>=20`
- **pnpm** — install from the repo root; web joins the workspace at `forge/`
- A running [`@forge/core`](../core) (or any Forge-API-compatible backend) reachable over HTTP/WS

## Install

```bash
# From the repo root
pnpm install
```

## Environment

Copy `.env.example` to `.env.local` and adjust. Only `NEXT_PUBLIC_API_URL` is required; the rest are optional and gracefully degrade.

| Variable | Default | Purpose |
|---|---|---|
| `NEXT_PUBLIC_APP_URL` | `http://localhost:3000` | public origin of this web app — canonical links + OG metadata |
| `NEXT_PUBLIC_API_URL` | `http://localhost:8080/api` | core REST base; must end in `/api` |
| `NEXT_PUBLIC_WS_URL` | derived from API URL | core WebSocket override (`ws://…/ws`) |
| `NEXT_PUBLIC_SPLINE_SCENE_URL` | bundled landing scene | replace landing-page Spline 3D scene |
| `NEXT_PUBLIC_BOOKING_URL` | `#book` anchor | "Book a demo" CTA target |
| `NEXT_PUBLIC_ENV_LABEL` | empty | banner label (e.g. `STAGING`, `PREVIEW`) |

## Run locally

```bash
cd forge/web
pnpm dev          # http://localhost:3000
```

The app expects core at `NEXT_PUBLIC_API_URL`. If you started the root `docker compose up -d`, that's `http://localhost:8080/api` already.

## Build

```bash
cd forge/web
pnpm build
pnpm start        # serve the production build
```

## Tests

```bash
pnpm --filter web test          # vitest (component + unit)
```

## Architecture

- `src/app/` — App Router pages (auth, projects, settings, usage, landing, download)
- `src/features/<domain>/` — per-feature `api.ts` + `types.ts` + `hooks/` + `components/` (issue, project, task, comment, agent, usage)
- `src/components/` — shared UI: chat, issue, layout, ui primitives
- `src/lib/` — API client, validation schemas (zod), constants, env-label helper
- `src/providers/` — React Query + Auth context

→ Module behavior is documented at [`docs/modules/`](../../docs/modules/) at the repo root. Web is one of three clients (web, dev, app) that all consume the same core contract — never re-derive shapes, import from [`@forge/contracts`](../contracts).

## Embeddable widget

`pnpm build:widget` builds `dist-widget/forge-widget.js` and copies it into [`@forge/core`](../core)`/public/` so core can serve it from `/widget/<project>/forge-widget.js`. Source lives in [`vite.widget.config.ts`](./vite.widget.config.ts).

## Other scripts

| Script | Purpose |
|---|---|
| `pnpm lint` | ESLint over `src` |
| `pnpm dev` | Next.js dev server (Turbopack) |
| `pnpm build` | Production build |
| `pnpm start` | Serve production build |
