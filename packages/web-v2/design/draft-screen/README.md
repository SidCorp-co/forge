# Draft screens — web-v2 redesign reference set

10 standalone HTML mockups (Claude design, 2026-06). Same brand as the web-v2 kit:
flame `#F15A2B` / cobalt / warm paper, Hanken Grotesk + JetBrains Mono. Long-lived
reference for incremental web-v2 improvements — not tied to a single issue.

## Inventory → web-v2 mapping

| File | Screen | Maps to | Net-new vs web-v2 |
|---|---|---|---|
| `01 Dashboard.html` | Project dashboard | `/projects/[slug]` | needs-attention queue, View chain |
| `02 Issues.html` | Issues (Board/List/Insights) | `/projects/[slug]/issues` + `/pipeline` | merges kanban into Issues tabs; Cost/Throughput columns |
| `03 Issue detail.html` | Issue detail | `/projects/[slug]/issues/[id]` | inline run history + per-agent activity |
| `04 Agents.html` | Agents ops console | `/sessions` + `/projects/[slug]/agents` | zombie jobs, median wait metrics |
| `05 Agent run.html` | Agent run detail | `/projects/[slug]/agents/[sessionId]` | **Take over**, Files changed, Tasks |
| `06 Library.html` | Library | `/projects/[slug]/library` | **MCP servers** section (new) |
| `07 Automation.html` | Automation | `/projects/[slug]/automation` | **Pipeline policies** (approval gating, auto-retry) |
| `08 Workspace overview.html` | Workspace overview | `/` | cross-project rollup; no-project rail state |
| `09 Usage.html` | Usage | — (no v2 route yet) | **entire screen new**: spend by project/model/stage + budget |
| `10 Runners.html` | Runners | `/runners` | busy/idle/zombie health metrics |

Nav rail + top header (visible on every screen): see **ISS-358**.

## How to view

```bash
cd packages/web-v2/design/draft-screen && python3 -m http.server 8731
# open http://127.0.0.1:8731/02%20Issues.html
```

`file://` is blocked in Playwright — always serve over HTTP. Theme: mockups default
dark; light values live in the `html[data-theme="light"]` CSS block (web-v2 ships
light-first — take light values from that block).

## How to read the files

- Each file = outer canvas shell + **one** inner screen document embedded as a
  1-level escaped string (`\"`). Grep on raw source sees tags doubled (outer +
  inner) — there is only ONE screen per file, no version copies.
- Runnable React-via-Babel-standalone bundles. **Render, don't parse**: load over
  HTTP and inspect via browser / Playwright a11y snapshot.
- The Dark/Light pill (bottom-right) is a canvas control, **not app chrome** — do
  not implement it.

## Key metrics

| Token | Value |
|---|---|
| Rail width | 236px (`--rail-w`) |
| Top bar height | 56px (`--topbar-h`) |
| Sample data | `FRG-*` / `DPL-*` issue keys, "Sid Kumar" — fictional |
