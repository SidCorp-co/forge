# ADR draft — Chat answers visually, through registered ports

**Removed when:** the requirement filed from this draft ("Chat answers visually: reports,
diagrams, templates, share links") is agreed, and the change that accepts this ADR copies it into
`docs/adr/` as the next free number and deletes this file. Until that requirement has a key, it
extends the assistant requirement REQ-30, whose BC-11 already holds the executor's sandbox
boundary.

**Status:** proposed · **Date:** 2026-10-08 · **Read at:** `daebec715` on `dev` · **Requirement:**
REQ-30 now; the new requirement once filed

## Context

The owner decided on 2026-10-08 that the Assistant and Agent chat will be used a lot, and that a
question about logic, workflows or reporting gets a visual, explicit, professional answer: drawn,
written, summarised and reported. The agreed direction is **data by code, look by blocks, words
by model**:

1. typed report queries in core, permission-checked, one call returning one assembled dataset;
2. render blocks the chat UI draws natively — table, chart, logic or flow diagram, roadmap
   timeline, KPI row, status list with links — which the model emits as structured data;
3. report templates: a query set, a block layout and narrative slots the model fills, saved,
   exported and scheduled through the existing status-reports module;
4. a sandbox only for the long tail, its results returned as blocks, and a recurring script
   promoted to a query or template.

The owner then ruled ("tôi muốn build dạng pattern chuẩn và nó là linh động dạng adapter đừng
cắm sâu vào logic…"): a standard pattern, flexible as adapters, **not wired deep into the
assistant's logic**, so the project's structure does not break; and sharing uses **a Forge share
link, built if missing — not Claude artifacts**, to reduce the dependency. This draft turns that
into ports and adapters.

### What the tree already has

| Piece | Where | What it gives this design |
|---|---|---|
| Port slots handed in at boot | `packages/core/src/lib/port-slot.ts:portSlot`; `packages/core/src/status-reports/ports.ts`, `packages/core/src/agent-reports/ports.ts` | the shape every port below takes: a domain declares what it needs, the process entry provides it, and the domain never imports the provider |
| A registered adapter set | `packages/core/src/integrations/registry.ts:registerIntegration` | a Map keyed by id that refuses a duplicate and refuses to be read empty; the registry shape every port below copies |
| Module kinds and direction | ADR 0006, ADR 0008, `packages/core/src/modules.json`, `scripts/lib/module-boundaries.mjs` | door → read-model → domain → kernel → platform; a vendor only inside `integrations/<port>`; `assistant` sits in the `conversations` context, which may not import `operations` |
| Tools composed into chat without the assistant importing them | `packages/core/src/assistant/tools/registry.ts:provideChatTools`, `packages/core/src/mcp/chat-read-tools.ts:CHAT_READ_MODEL_TOOLS` | the route a new chat tool takes; the assistant module needs no edit to gain one |
| One status read | `packages/core/src/project-status/read.ts:readProjectStatus`, tool `forge_project_status` | the progress, release and roadmap figures already exist as one read; queries below wrap it, never recompute it |
| Stored, scheduled reports | `packages/core/src/status-reports/store.ts:storeStatusReport`, `packages/core/src/status-reports/send.ts:sendStatusReport`, the `status_report` schedule kind in `packages/contracts/src/schedules.ts` | save, history, diff, schedule and notify, today for one fixed report |
| Structured, service-written message blocks | `packages/core/src/lib/agent-stream-parser.ts:ContentBlock` (`questionnaire`, `designs`, ISS-63), `packages/core/src/conversations/canonical-entry.ts:asBlocks`, `packages/web-v2/src/features/onboarding/components/thread-blocks.tsx` | the `blocks` column on `conversation_messages` already carries typed blocks: a new block kind needs no migration |
| Reply checks | `packages/core/src/messaging/status-claims-rule.ts`, `packages/core/src/messaging/grounding-rule.ts`, `packages/core/src/messaging/creation-claims-rule.ts`, `no-empty-promise` in `packages/core/src/messaging/text-rules.ts` | claims must rest on a read this turn made; a record claimed must have been written; no promise of later work |
| Renderers in web | `packages/web-v2/src/components/ui/chart.tsx` (recharts), `packages/web-v2/src/features/workflows/canvas/` (`@xyflow/react` + `elkjs`), `packages/web-v2/src/design/patterns/mermaid.tsx` (`securityLevel: "strict"`), `packages/web-v2/src/design/patterns/markdown.tsx` (react-markdown + remark-gfm) | every block below is drawn with a library already in `packages/web-v2/package.json` |
| Markdown export of a report | `packages/web-v2/src/features/project-status/report-markdown.ts:statusMarkdown` | the precedent for a block's text fallback |
| Sandbox options | `docs/proposals/assistant-sandbox.md` | options (a) Anthropic code execution, (b) E2B, (d) runner `exec` job; mapped onto the Executor port below |
| Expiring tickets, hashed tokens | `download_tickets` (`packages/core/src/db/schema-uploads.ts`), `token_hash` columns in `packages/core/src/db/schema-projects.ts` | the share link reuses both shapes; **no share link exists today** (searched core and contracts for `share link`, `shareLink`, `share_token` on 2026-10-08: the only hits are web's copy-a-deep-link helper, which shares a URL a member must sign in to open) |

### How others structure this

Read on 2026-10-08; each path was fetched from the repository's default branch. Shapes are
summarised, no code is copied.

| Project | Where | Shape | What this design takes |
|---|---|---|---|
| Vercel AI SDK UI | `vercel/ai` `packages/ai/src/ui/ui-messages.ts` (`UIMessagePart`, `ToolUIPart`), `packages/provider-utils/src/types/tool.ts` (`tool()` with `inputSchema`, `outputSchema`, `execute`) | a message is an array of typed parts; a tool part is `tool-<name>` with states `input-available` → `output-available` / `output-error`; the client picks the component by part type | a block is a typed part of the message, plain data from the server, drawn by kind on the client. The older RSC `streamUI` (`packages/rsc/src/stream-ui/stream-ui.tsx`) streams server components and is marked experimental — not taken: the server must not ship UI |
| Backstage backend and frontend | `backstage/backstage` `packages/backend-plugin-api/src/wiring/createExtensionPoint.ts`, `createBackendPlugin.ts`, `createBackendModule.ts`; `packages/frontend-plugin-api/src/wiring/createExtensionBlueprint.ts` | the plugin declares an extension point (a typed ref with no implementation); a module imports the ref and registers into it; the plugin never imports the module; the app root composes both | the dependency direction of every port here: the consumer declares the slot, the adapter registers, the process entry composes |
| Grafana | `grafana/grafana` `packages/grafana-data/src/types/datasource.ts` (`DataSourceApi.query`), `packages/grafana-data/src/types/dataFrame.ts` (`DataFrame`, `Field`), `packages/grafana-data/src/panel/PanelPlugin.ts` | data sources return `DataFrame[]` (columns of `{name, type, values, config}`); panels consume frames; neither knows the other | **one interchange shape**, the report frame, between queries and blocks; units and display hints on the field |
| Metabase | `metabase/metabase` `frontend/src/metabase/viz-core/lib/registry.ts` (`registerVisualization`), `frontend/src/metabase/visualizations/visualizations/Funnel/definition.ts` | a registry keyed by a static identifier that throws on a duplicate; a definition answers `isSensible(data)` and `checkRenderable(series, settings)` separately | a block kind answers "does this frame suit me" and "is this block valid" as two checks with two refusals |
| Apache Superset | `apache/superset` `superset-frontend/packages/superset-ui-core/src/chart/models/ChartPlugin.ts` and the five `registries/Chart*RegistrySingleton.ts` | a chart plugin bundles metadata, `buildQuery`, `transformProps` and a lazily loaded component | `transformProps` as the one pure step from a frame to renderer props, kept on the web side |
| Mermaid | `mermaid-js/mermaid` `packages/mermaid/src/diagram-api/diagramAPI.ts` (`registerDiagram`), `packages/mermaid/src/config.type.ts` (`securityLevel`) | diagrams registered with a detector; `securityLevel` `strict` for untrusted text | Forge already renders mermaid at `strict`; the flow block is structured nodes and edges instead, so no model text is parsed as markup |
| E2B | `e2b-dev/E2B` `packages/code-interpreter-python/e2b_code_interpreter/models.py` (`Execution`, `Result`) | an execution returns typed results, logs and a structured error; a result prefers `json` or `chart` data over an image | the Executor port returns frames and logs, never a picture of a chart |

## Decision (proposed)

**Five ports, each a registry declared by the module that consumes it and filled at boot by the
process entry.** No consumer imports an adapter. The assistant gains its abilities as chat tools
composed through `provideChatTools`, exactly as `forge_project_status` reaches it today, so no file
under `packages/core/src/assistant/` changes to add a query, a block kind, a template, an executor
or a share target. Every contract type lives in `packages/contracts`, so core, web and a door
read one declaration.

The registries share one mechanism, copied from `packages/core/src/integrations/registry.ts`: a
Map keyed by a stable id; a duplicate id refused at registration naming both; a read of an empty
registry refused naming the boot call that was skipped; an unknown id refused naming the id and
the ids that exist. Nothing absorbs an unknown entry silently. (`asBlocks` today skips an unknown
block type silently; the `visual` kind below is read through the block registry instead, and a
stored block whose kind is no longer registered is drawn as a named "unsupported block" row,
never dropped.)

### Port 1 — ReportQuery: data by code

**Contract** (`packages/contracts/src/report-queries.ts`, new):

- `ReportQueryDescriptor` — `id` (kebab, stable), `version` (integer, bumped on any output change),
  `title`, `params` (a zod object; unknown keys refused by name), `output` (the frame's declared
  fields), `permission` (a `Permission` from `packages/contracts/src/permissions.ts`, at least
  `project.read`), `egress` (the data-egress surface the rows belong to, so an operational source
  such as feedback is classed as it is today), `surfaces` (`rest`, `chat`, `cli` — the
  one-question-one-answer flag of `docs/proposals/destination/one-question-one-answer.md`).
- `ReportFrame` — the one interchange shape, after Grafana's frame: `fields[]` of
  `{ name, type: 'string'|'number'|'date'|'duration'|'status'|'ref', unit?, label }` and `rows[]`;
  a `ref` cell is an entity key (`ISS-12`, `REQ-3`, `FB-9`, a release version) the renderer turns
  into a link for a member.
- `ReportRun` — `{ runId, queryId, version, params, projectId, actor, asOf, frame }`: **every
  figure carries the query and the read that produced it.**

**Registry:** `report-queries`, a new **read model** in the `operations` context beside
`project-status`, `forecast` and `metrics`. A query is an adapter of this port: one file per
query, registered in the module's registry, declaring under `reads` in `modules.json` the tables
it SELECTs (ADR 0008, ISS-188 amendment). A query that summarises an existing read calls that
read; it never computes the same fact a second way.

**First adapters (Phase A):**

| Query | Answers | Built over |
|---|---|---|
| `progress-by-requirement` | per requirement: criteria proven of total, issues shipped / awaiting release / to do | `readProjectStatus` (`requirements` section) |
| `roadmap-eta` | now / next / later by requirement, each with its p50–p85 forecast range | `readProjectStatus` (`roadmap`), `packages/core/src/forecast/scope.ts:readForecastLine` |
| `release-readiness` | the next release: state, progress, whose turn, what blocks it | `readProjectStatus` (`nextRelease`), the release read behind `forge_release` |
| `criteria-coverage` | per requirement criterion: proven, failing, untested, and by which issue | the requirement read behind `forge_requirement` |
| `workflow-status` | per workflow design: steps and their health markers, with the design graph | `packages/core/src/workflows/health-read.ts:projectHealthAs` |

Phase B adds `feedback-trends` (over `packages/core/src/feedback/list-read.ts:listFeedbackAs`,
operational egress) and `risk` (late items, waits and failing criteria, over the reads above).

**Door:** REST first — `GET /api/projects/:id/report-queries` lists descriptors; `POST
/api/projects/:id/report-queries/:queryId/runs` runs one as the caller and returns the
`ReportRun`. The chat tool `forge_report` and the CLI call the same service and answer
identically.

**Who may add one:** a core change to `report-queries`, reviewed like any read model, with its
`reads` declared. Never a project, never a model, never a template.

### Port 2 — Block: look by blocks

**Contract** (`packages/contracts/src/visual-blocks.ts`, new): `VisualBlock` is a discriminated
union on `kind`, each kind a zod schema with a `v` (schema version):

| Kind | Holds | Drawn by (web) |
|---|---|---|
| `table` | columns picked from the frame, sort, row limit | flush table, hairline dividers |
| `chart` | `variant: bar \| line \| burndown`, x field, y fields, series | `packages/web-v2/src/components/ui/chart.tsx` over recharts |
| `flow` | nodes and edges with plain-text labels, at most 60 nodes; or a `workflow-status` frame's graph | `@xyflow/react` laid out by `elkjs`, as the workflow canvas does |
| `timeline` | items with a start, an end or a p50–p85 range, and a lane | a flat roadmap strip |
| `kpi` | two to six figures, each a field of one row, with a label and an optional delta | a flat row of figures, no cards |
| `status-list` | rows of `{ ref, status, waitingOn }` | a list whose `ref` links to the entity |

Every block holds either a `source: { runId }` with the frame copied from that run, or, for a
`flow` block only, model-authored nodes and edges that carry **no figures**. A figure the model
typed is not a block field: a number reaches a block only from a run.

**Each kind answers four things**, after Metabase's split and Superset's pure step:
`isSensible(frame)` (does this frame suit the kind), `check(block)` (is the block valid — refused
by name, with the field and the valid shape), `toText(block)` (the plain-text and Markdown
fallback that external chat doors, export and screen readers read), and on the web side a
renderer keyed by the same `kind`.

**Registry:** the schemas and `isSensible` / `check` / `toText` are data and pure functions in
`packages/contracts`, registered in one table there; the web renderer registry lives in a new
web feature, `packages/web-v2/src/features/visual-blocks/`, keyed by the same ids. A parity test
fails when a contract kind has no web renderer or a renderer has no contract kind.

**How a block reaches a message:** a new `ContentBlock` type `visual` in
`packages/core/src/lib/agent-stream-parser.ts`, stored in the `blocks` column that already
exists. Like `questionnaire` and `designs`, it is written by a service, never by the model's
text: the model calls the chat tool `forge_show` with `{ block: { kind, source: { runId }, ...fields } }`;
`reports` (`packages/core/src/reports/blocks.ts:attachVisualBlock`) reads the run back as the
asker, copies its frame in, checks the block against the registry, and posts it into the room as a
service-written answer above the reply (the reply row is the assistant's, which no tool edits). The
stored block carries its run's `{ runId, queryId, version, asOf }` beside the frame, which is what
web shows as its source. A block that brings a frame of its own must bring its run's exactly, or it
is refused naming each figure the run never read; a run is read back only by the person it was read
as, and past its 30-day keep it reads as gone, by name. Only a web room draws a block; another door
is refused until B5. In Agent mode the session reaches the same service over REST
(`POST /api/conversations/:id/blocks`), as Agent mode reaches every other Forge write.

**Who may add one:** one change that adds the contract schema, `isSensible`, `check`, `toText`
and the web renderer together. The parity test refuses half of it.

### Port 3 — Template: declarative data

**Contract** (`packages/contracts/src/report-templates.ts`, new), following the built-in workflow
templates (`packages/contracts/src/workflow-template-builtins.ts` over
`workflow-template-schema.ts`):

- `id`, `version`, `title`, `params` (a zod object);
- `queries[]` — `{ as, query, params }`, where a param value is a literal or the name of a
  template param, and nothing else;
- `layout[]` — blocks as above, each naming the `as` of the run it draws instead of a `runId`;
- `narrative[]` — slots the model fills: `summary`, `risks`, `recommendations`, each with a
  guidance sentence and a word cap.

**A template is data, never code**: no expressions, no formulas, no functions, no conditionals.
A derived column is a query's job. The validator refuses an unknown key, an unknown query id, a
param binding that is not a declared name, and a block whose kind finds the frame not sensible.

**Run:** `reports` runs each query as the asker, draws the layout, then asks the model to fill the
slots from those runs only; each slot's text passes the reply check against the template's runs.
A template's output is one `ReportDocument` — `{ templateId, version, params, runs[], blocks[],
narrative }` — which is what the chat shows, what status-reports stores, and what a share link
freezes.

**First adapters (Phase A):** `progress`, `release`, `roadmap`, built in as contract data.

**Who may add one:** a built-in template is a contracts change. In Phase B a project member with
`reports.write` saves a project template; it is validated by the same schema, so a project
template can do nothing a built-in cannot.

### Port 4 — Executor: the long tail

**Contract** (`packages/contracts/src/report-executions.ts`, new):

- `ExecutionRequest` — `{ language: 'python' | 'bash', script, inputs: ReportFrame[] (a snapshot),
  limits: { wallMs, cpu, memoryMb, outputBytes } }`;
- `ExecutionResult` — `{ executionId, adapter, exit, durationMs, stopped?: <the limit hit>,
  frames: ReportFrame[], logs: { stdout, stderr } (capped), error? }`, after E2B's `Execution`:
  data, not pictures.

**Registry:** an executor slot in `reports` (a `portSlot` holding a registry). Each adapter
declares `id`, `mode: 'invoked' | 'in-band'`, `isolation`, `network: 'none'`, `dataLeavesTo`,
`zdrEligible`, and `availableFor(project)`.

**Adapters, mapped onto `docs/proposals/assistant-sandbox.md`:**

| Adapter | Option there | Mode | Where it lives |
|---|---|---|---|
| `anthropic-code-exec` | (a) | **in-band**: offered as a provider tool on the Anthropic wire; the LLM adapter translates the provider-executed call and its result into one `ExecutionResult` | `packages/core/src/integrations/llm/` — the only place that may name the vendor's tool or types |
| `e2b` | (b), the named fallback | invoked | `packages/core/src/integrations/executor/e2b/` (new port directory; deployment-bound, its key from the environment) |
| `exec-node` | (d), the runner `exec` job | invoked; core admits the job and sets its limits, the box runs it under bubblewrap or Seatbelt and reports | an adapter provided by the `jobs` module at boot; the runner side is a job kind (ADR 0009) |

`schedules/script` (`packages/core/src/schedules/script/executor.ts`, a `node:vm` context in a
worker thread) is **not** an adapter of this port: `node:vm` is not a security boundary, so it
cannot run model-written code over project data.

**Who may add one:** an adapter is a change under `integrations/executor/<vendor>/` (or a module
providing one at boot), enabled per deployment; the sandbox ADR's requirement additions (inputs,
retention, network, permission `assistant.exec`, budget, record, opt-out) bind every adapter.

### Port 5 — Share: a Forge share link

**Contract** (`packages/contracts/src/shares.ts`, new): `ShareTarget` adapters turn a frozen
`ReportDocument` into something a reader opens. **One adapter, `forge-link`, is built.** The port
exists so a later target (a mail digest, a PDF file) is an adapter beside it; a target that hands
the document to a third-party host (claude.ai artifacts included) is refused by the owner's
ruling and is not registered.

**The `forge-link` adapter:**

- **Scoped.** A link points at one frozen snapshot — a message's blocks, a template's output or a
  stored status report — never at a live query, a conversation, or the project.
- **Frozen and scrubbed.** At creation, the snapshot is copied into the link row after
  `scrubSecretsDeep` and the project's data policy (`packages/core/src/lib/data-egress.ts:egressDeep`
  with a new surface, `report.share`); a project at `no_egress` cannot create a link-audience
  share. Emails never enter a snapshot; people appear by display name.
- **Permission-checked.** Creating needs `shares.write` (member by default) and a fresh read, as
  the creator, of every run the snapshot holds, made by the subject source registered for the
  subject's kind (`packages/core/src/shares/ports.ts:ShareSubjectSource`); a run the creator can no
  longer read refuses the share by name, and a kind with no source registered is refused naming the
  kinds that have one. Two audiences: `members` (opener must be signed in and hold `project.read` now)
  and `link` (anyone with the token; creating one needs `shares.public`, admin by default and
  token-explicit per ADR 0007).
- **Expiring.** `expires_at` is required: default 7 days, at most 30.
- **Revocable.** The creator or a `project.admin` revokes it, effective on the next request. A share
  stands only while its creator still holds the permission that created it (`shares.write`, or
  `shares.public` for a `link` share), read on every open, so a creator who leaves the project or
  loses that permission stops their links on the next request.
- **Read-only.** The page `/s/[token]` draws the snapshot as data — each block by its text fallback
  (`packages/web-v2/src/features/shares/components/shared-answer.tsx:SharedBlock`) while the web block
  registry holds no renderer for it — with no actions, no navigation and no live reads; for the `link` audience, `ref` cells render as text,
  not links.
- **Stored.** A `share_links` table owned by a new `shares` domain (`operations`): `id`,
  `project_id`, `token_hash` (SHA-256 of a 256-bit random token shown once), `audience`,
  `subject_kind`, `snapshot` (jsonb), `created_by`, `created_at`, `expires_at`, `revoked_at`,
  `revoked_by`, `view_count`, `last_viewed_at`.
- **Served** with `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and
  `X-Robots-Tag: noindex`, and rate-limited per token and per address. The token reaches core only
  in a request body (`POST /api/shares/open`, and `/api/shares/open/member` for a signed-in reader),
  never in a core path, and carries the prefix `forge_share_` that the log scrubber
  (`packages/observability/src/index.ts:scrubLogText`) redacts wherever it appears.

## How the assistant and the reply check use the ports

- **Tools, composed, not wired.** `forge_report` (run a query), `forge_show` (attach a block),
  `forge_template` (run a template) and, in Phase C, `forge_compute` (run an execution) join
  `CHAT_REPORT_TOOLS` in `packages/core/src/mcp/chat-report-tools.ts` and reach the
  assistant through `provideChatTools`. The assistant's turn loop, prompt composer and providers
  are unchanged; the system prompt gains one guide entry saying when to answer with a block, as
  text in `packages/core/src/assistant/prompt/base.ts:BASE_LAYER` (prompt text, not logic).
- **A template run.** `forge_template` (`packages/core/src/reports/templates.ts:runTemplate`)
  runs each of the template's queries as the asker through `runReport`, so every figure is a
  stored run, draws the layout over their frames and answers the slots empty with their guidance.
  A block its frame cannot fill (a `kpi` or `timeline` over no rows) is named in `notDrawn`, never
  dropped quietly. A second call with `runIds` and `narrative` is
  `checkTemplateNarrative`: the runs must be the template's own queries in its order, and a slot
  over its words or stating a number no run returned is refused by name. Agent mode reaches both
  over `POST /api/projects/:id/report-templates/:templateId/runs` and `.../narrative`.
- **Sharing a template output.** The `template-output` subject is `<templateId>:<runId>,<runId>`
  (`reports/template-share-source.ts`); each run is read again as the creator. The narrative is
  held nowhere a share can reach before B3 stores a `ReportDocument`, so a shared output carries
  its blocks and runs with every slot empty. Saving and scheduling a template run through
  `status_reports` is B3 and needs its migration.
- **Grounding a figure.** `MessageFacts` (`packages/core/src/messaging/facts.ts:FigureFacts`) carries
  the values of the turn's report runs: every run a result of this turn or a block it drew names by
  id, read from `report_runs` through the `reportRunFrames` message read
  (`packages/core/src/reports/runs.ts:keptRunFrames`), its own project's and unexpired only. The rule
  `figures-grounded` (`packages/core/src/messaging/figures-rule.ts`) refuses a reply whose prose
  states a percentage, a ratio, a count of tracked things or days, a count of a state or a total
  that no such run holds, quoting the figure; and any number typed into a block's title or labels,
  flow labels included. Dates, ids, versions, ordinals, quoted sources and numbers the person typed
  in the question are exempt, by the table in `figure-exemptions.ts`. It judges at the chat doors
  where the turn could run a report: a turn offered `forge_report` or `forge_template`, and an
  Agent session, whose REST runs are read from its tool results. A block whose frame differs from
  its run's is refused when it is attached (`packages/core/src/reports/figures.ts:figuresNotInRun`).
  `status-claims-rule.ts` counts the report tools as grounding every claim family but a decision;
  `creation-claims-rule.ts` refuses "I shared this", a share link, or "I saved the report" where the
  turn made no share (`POST /api/projects/:id/shares`) or status-report save, and no
  unverified mark exempts a claim to have written a record.
- **Executor output is untrusted.** A frame from an execution carries `source: { executionId }`,
  is labelled as computed in the block, and never drives a write without the person's confirmation
  (REQ-30 BC-4).

## Module boundaries and dependency direction

| Module | Kind | Context | Owns | Imports |
|---|---|---|---|---|
| `report-queries` (new) | read-model | operations | nothing; `reads` declared per query | project-status, forecast, workflows, requirements, feedback read files; contracts |
| `reports` (new) | domain | operations | `report_runs`; Phase B `report_templates` | contracts, kernels, platform; queries and executors **only through its ports** |
| `shares` (new) | domain | operations | `share_links` | `reports`' face; permissions; `lib/data-egress.ts` |
| `integrations/executor` (new) | adapter | adapters | nothing | platform only (ADR 0008: an adapter imports no domain) |
| `integrations/llm` | adapter | adapters | — | gains the in-band executor translation |
| `assistant` | domain | conversations | unchanged | unchanged: tools arrive by `provideChatTools` |
| `mcp` | door | platform | — | registers the new tools (the only importer of `tool.ts`) |
| web `visual-blocks` (new) | web feature | — | — | contracts; recharts, xyflow, elkjs through the existing design wrappers |

The process entry (`packages/core/src/index.ts`) composes: it provides `report-queries`' registry
to `reports`, the executor adapters to `reports`, and the tools to the assistant — the Backstage
direction: the consumer declares the slot, the adapter registers, the root wires.

**What must not happen** — each is refused by `check-module-boundaries`, `check-provider-literals`
or a review, and none is waived:

- assistant code importing a vendor SDK, a vendor's types or a vendor tool name for rendering or
  execution (`@ai-sdk/anthropic`'s code execution tool belongs in `integrations/llm` alone);
- assistant code importing `report-queries`, `reports`, `shares` or an executor (a context it may
  not import, and the owner's "not wired into the logic");
- a template holding code: an expression, a formula, a script, an HTML string or a function;
- a block whose figures the model typed, or a block kind with no text fallback;
- web rendering model text as HTML or as markup it parses (mermaid stays at `strict`; the flow
  block is structured data);
- a second computation of a fact a read already decides (progress, lateness, forecast);
- a share target that hosts the document with a third party, or a share that reads live data at
  view time;
- `node:vm` or a child of the core process running model-written code.

## Phased plan

Lanes are about one day. Migration indices and `when` values are assigned by the dispatcher.

### Phase A — Block port, five queries, three templates, the share minimum

| Lane | Delivers | Migration |
|---|---|---|
| A1 contracts | `report-queries.ts`, `visual-blocks.ts` (six kinds with `isSensible`, `check`, `toText`), `report-templates.ts`, `shares.ts`; `modules.json` entries for `report-queries`, `reports`, `shares` and web `visual-blocks` with their `serves` | none |
| A2 query registry and door | `report-queries` registry, REST list and run, `progress-by-requirement`, `roadmap-eta` | none |
| A3 three more queries | `release-readiness`, `criteria-coverage`, `workflow-status`, each with `reads` declared | none |
| A4 runs and blocks in core | `reports` domain: `report_runs` writer (run provenance and frame, kept 30 days), `forge_report` and `forge_show` tools, `ContentBlock` `visual`, block validation against the run | **yes: `report_runs`** |
| A5 web block registry, part 1 | `features/visual-blocks` registry and the parity test; `table`, `kpi`, `status-list`; the thread draws `visual` blocks and an unsupported block by name | none |
| A6 web block registry, part 2 | `chart` (bar, line, burndown), `timeline`, `flow` | none |
| A7 templates | `progress`, `release`, `roadmap` as contract data; template run with narrative slots; `forge_template` | none |
| A8 reply check | `figures-grounded` rule; report queries as grounding tools in `status-claims-rule.ts`; share and save claims in `creation-claims-rule.ts` | none |
| A9 share minimum | `shares` domain, create, revoke and view; `members` and `link` audiences; expiry; `report.share` egress surface; permissions `shares.write`, `shares.public`; `/s/[token]` page | **yes: `share_links`** |

### Phase B — more templates, export, schedule

| Lane | Delivers | Migration |
|---|---|---|
| B1 two more queries | `feedback-trends`, `risk` | none |
| B2 saved project templates | `report_templates` writer, `reports.write`, the template picker in chat | **yes: `report_templates`** |
| B3 templates in status-reports | a stored report holds a `ReportDocument`; the `status_report` schedule takes `templateId` | **yes: `status_reports` gains template id, version and document** |
| B4 export | Markdown from `toText`, CSV per `table` block, a print stylesheet for PDF | none |
| B5 doors | external chat doors (Rocket.Chat) post `toText` with a member link | none |
| B6 more templates | weekly delivery, requirement coverage, feedback digest | none |

### Phase C — executor adapters, promotion

| Lane | Delivers | Migration |
|---|---|---|
| C1 executor port and record | registry in `reports`, `forge_compute`, `assistant.exec`, per-turn caps, the execution record | **yes: `report_executions`** |
| C2 `anthropic-code-exec` | the sandbox draft's Phase 1 (`bridgeStream` provider events, container per conversation, scrubbed uploads) behind the port | none |
| C3 `e2b` | the fallback adapter under `integrations/executor/e2b/` | none |
| C4 `exec-node` | the runner `exec` job (sandbox draft Phase 2), only after REQ-30 BC-2 is revised | none in core beyond C1; a job kind |
| C5 promotion | a script whose fingerprint ran three times in 30 days is offered to an admin for promotion: as a Feedback or Requirement draft carrying the script and a sample frame, never as an automatic query | none (reads `report_executions`) |

## Threat model

### Share links

| Threat | Path | Control |
|---|---|---|
| Token leaks | pasted in chat, a proxy log, a `Referer` header, browser history | only the hash is stored; `no-referrer`; `no-store`; short expiry; revocation on the next request; the token reaches core only in a request body, and the scrubber redacts its `forge_share_` shape in every log line and error report, so it never reaches Forge's own logs |
| Guessing | enumerating tokens | 256-bit random token; per-token and per-address rate limit; one answer for unknown, expired and revoked |
| Wider data than meant | a link that reads live | the snapshot is frozen at creation; the view does no query |
| Stale authority | the creator is demoted or leaves | creation re-reads every run as the creator; every view re-reads the creator's `shares.write` or `shares.public`, so leaving stops the creator's links; a `members` link re-checks the opener's `project.read` every view |
| Secrets or personal data | a frame cell holding a token or an email | `scrubSecretsDeep` and the project's data policy at creation; emails never copied; `no_egress` projects cannot create `link` shares |
| Injected markup | model text in a title or a flow label | blocks are data drawn as text; no HTML; no markup parsing |
| Indexing and caching | a crawler, a shared cache | `noindex`, `no-store`, no sitemap entry |
| Silent misuse | a link opened far more than expected | `view_count` and `last_viewed_at` on the share list; every create, view and revoke is an activity row |

### Executors

The adapter-level model is `docs/proposals/assistant-sandbox.md`'s threat table, which every
adapter inherits. The port adds:

| Threat | Control at the port |
|---|---|
| Inputs beyond the asker's reach | core builds the input snapshot from runs made as the asker (in a room, the intersection of what every member may read), scrubbed before it leaves |
| Output treated as fact | an execution's frame is labelled computed, cites its `executionId`, and drives no write without confirmation |
| A vendor type leaking inward | the port's contract is Forge's; `check-provider-literals` refuses a vendor name outside `integrations` |
| Unbounded cost | per-turn caps on executions and wall time, a monthly project cap, each hit reported as a stop naming the limit |
| An adapter weaker than declared | an adapter declares `isolation`, `network` and `dataLeavesTo`; a project's opt-out (ZDR, no third-party processing) filters adapters by those fields, and a request no adapter may serve is refused by name, never routed to a weaker one |

## Honest costs

- **Three new modules and four registries** where one chat-side feature would be smaller; the price
  of keeping the assistant free of report logic is a composition step at boot for every addition.
- **Two migrations in Phase A** (`report_runs`, `share_links`) and three more later, each needing a
  migration number from the dispatcher and a deploy that runs it.
- **`report_runs` stores frames for 30 days**, which is project data held a second time; a sweep has
  to delete it, and a data-policy change has to reach it.
- **The parity test binds contracts and web together**: a new block kind cannot land in one package
  alone, so a block is always a two-package change.
- **`figures-grounded` will refuse some honest replies** (a figure stated from the question itself, a
  year in prose) until its grammar learns them; every false refusal costs a rewrite turn.
- **A `link` share is egress by design**: once opened, a snapshot cannot be called back from a reader
  who saved it; revocation only stops further views.
- **The in-band executor bends the port**: `anthropic-code-exec` runs inside the model's call, so core
  sees the script after the provider ran it, not before; its caps are enforced per turn rather than
  per call.
- **Agent mode reaches blocks only over REST**, so a resident session has to be taught the block verb
  through its guide, and until then its replies stay prose.
- **No third-party hosting** means Forge carries the page, the expiry sweep and the abuse controls
  that a hosted artifact service would have carried.
