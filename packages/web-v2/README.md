# web-v2

The Forge cloud UI — canonical at root `/` since ISS-397 (2026-06-07; legacy
`packages/web` retired).

- **Rules:** [`CODE-STANDARD.md`](CODE-STANDARD.md). **Page grammar:** [`src/design/README.md`](src/design/README.md),
  rendered at `/dev/design`.
- **Brand:** warm neutrals, a flame-orange accent, one hue per staged job type. Inter Variable for
  the UI and JetBrains Mono for keys and code. Light and dark, following the member's preference.
- **Stack:** Vite (React Compiler through Babel) · TanStack Router (file routes) · React 19 · Tailwind v4 (CSS `@theme`, no
  config file) · Base UI through shadcn (`src/components/ui`, wrapped by `src/design`) · lucide ·
  TanStack Query, Table and Virtual · Recharts · react-resizable-panels. It consumes the `core`
  REST/WS contract through `@forge/contracts`.

## Tokens

`src/styles/tokens.css` is the one source. `src/styles/globals.css` maps it into Tailwind with `@theme`.

1. **Scales:** OKLCH, 12 steps each, in the Radix manner, defined for light and dark. Both themes
   meet WCAG AA.
2. **Semantic:** `--bg-*`, `--fg-*`, `--border-*`, `--accent*` and `--status-*`, set on the scale
   steps. Components use this layer.
3. **Older names:** `--paper-*`, `--ink-*`, `--flame-*` and the rest are mapped onto scale steps, so
   older code themes too. The sweep moves them off.

## Layout

```
src/
├─ styles/tokens.css        # the one token source
├─ main.tsx                 # the router, rendered into index.html's #app
├─ routes/                  # file routes (thin) · __root.tsx (providers); `-name` files are not routes
├─ components/ui/           # shadcn (Base UI); imported only by src/design
├─ design/                  # primitives · patterns (blocks) · templates · icons; import from "@/design"
├─ features/<domain>/       # api.ts · hooks.ts · components/ · types.ts (copy: lib/i18n/copy/<domain>.json)
├─ lib/                     # api client, i18n copy, utils
└─ providers/               # theme, query, auth
```

## Run

```bash
pnpm --filter web-v2 dev      # http://localhost:3100  → Overview dashboard
```

`/` renders the Overview dashboard. The dev server proxies `/api` and `/ws` to a core at
`VITE_CORE_PROXY_URL` (default `http://localhost:8080`). `pnpm --filter web-v2 build` writes
`dist/`, which core serves itself when `WEB_DIST_DIR` names it (`packages/core/src/web-host`).

## Screen witness

jsdom lays nothing out, so the vitest suite cannot see a defect only a window width shows.
`witness/run.mjs` mounts a real component with the app's compiled CSS, and the stylesheets its
components import (the workflow canvas, the board), in headless Chrome at
each width its entry names and fails on every probe the entry reports:

```bash
pnpm --filter web-v2 witness witness/check-times.witness.tsx --out <dir>   # screenshots land in <dir>
```

An entry (`witness/*.witness.tsx`) stubs core's reads, mounts the component and sets
`window.__witness` — its cases, when it is ready, and its probe. An entry whose component has to be
used rather than only looked at declares `stages` in place of the probe: each acts on the same load
in order and is shot as `<case>-<stage>.png` (`witness/chat-dock.witness.tsx` clicks and drags the
Ask Agent panel). The page is a `file://` page in `<dir>`, so a file the component shows is put there
before the run (`witness/feedback-evidence.witness.tsx` names the two it reads). Chrome is `WITNESS_CHROME`,
else `google-chrome`. No CI job runs it: a screen change that can break at a width runs it and
attaches what it printed.
