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
  `{ name, type: 'string'|'number'|'date'|'duration'|'status'|'ref', unit?, label, vocabulary? }` and `rows[]`;
  a `ref` cell is an entity key (`ISS-12`, `REQ-3`, `FB-9`, a release version) the renderer turns
  into a link for a member. A `status` cell is drawn as the shared state badge; `vocabulary`
  (`REPORT_FIELD_VOCABULARIES` in `packages/contracts/src/report-queries.ts`) names the state
  family whose label and tone it wears, and a `status` field naming none reads sentence-cased and
  neutral.
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
| `progress-by-requirement` | per requirement of the Requirements list, every lane and off the roadmap: criteria proven of total, issues shipped / awaiting release / to do, lane and forecast dates as the list's ETA reads them (`deliveryDatesOf`) | `packages/core/src/requirements/read.ts:listRequirementsAs`, `packages/core/src/forecast/scope.ts:readRequirementForecasts` |
| `roadmap-eta` | now / next / later by requirement, each with its p50–p85 forecast range | `readProjectStatus` (`roadmap`), `packages/core/src/forecast/scope.ts:readForecastLine` |
| `release-readiness` | row 0: the release in flight (state, progress, whose turn, the draft behind it) or a `none_in_flight` row, with the window's shipped totals; then the releases shipped in the last `days` (default 14), newest first, with date, version and issue count | `readProjectStatus` (`nextRelease`, `shipped`) |
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
| `table` | columns picked from the frame, sort, row limit | flush table, hairline dividers; in a narrow container it scrolls sideways with its first column held, text clamped to two lines, ten rows then "Show all" |
| `chart` | `variant: bar \| line \| burndown`, x field, y fields, series | `packages/web-v2/src/components/ui/chart.tsx` over recharts |
| `flow` | nodes and edges with plain-text labels, at most 60 nodes; or a `workflow-status` frame's graph | `@xyflow/react` laid out by `elkjs`, as the workflow canvas does, drawn at its own size and scrolled sideways where its container is narrower |
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

**Adapters:** one, core's own script sandbox (REQ-37, `packages/core/src/sandbox/executor.ts:sandboxExecutor`),
which schedule scripts run in too: JavaScript in a QuickJS isolate compiled to WebAssembly, in a
worker thread, under a WebAssembly memory maximum, an interrupt at the wall cap and a stack limit,
with no host object inside it. A script reads Forge only through `ctx.forge.get`, by GET on its own
project, under a read-only token minted for the asker and revoked when the run ends; any other
method or path is refused `SCRIPT_READ_REFUSED`, and each read is kept on the execution. Python and
bash are refused by name. The provider's code execution tool and a hosted sandbox are ruled out by
the owner (2026-10-09): no Claude code-execution API and no direct provider key, models only through
the configured gateway.

**Who may add one:** an adapter is a module providing one at boot through `report-ports.ts`; the
port's checks below (inputs, retention, network, permission `assistant.exec`, budget, record,
opt-out) bind every adapter.

**C1, as built (2026-10-08).** The port, its record and its two doors. A deployment with no adapter
answers every computation `EXECUTOR_UNAVAILABLE` (503), naming that no executor is enabled on it.
What an adapter added since inherits:

- **Registry.** `packages/core/src/reports/executors.ts:provideExecutors` takes the deployment's
  adapters at boot (`report-ports.ts` passes `sandboxExecutor`); a duplicate
  id, or a descriptor off
  `ExecutorDescriptorSchema` (a network other than `none` among them), is refused at registration.
  A test registers its own fake through `registerExecutor`.
- **One service, two doors.** `packages/core/src/reports/compute.ts:computeExecution` is called by the
  chat tool `forge_compute` (in `CHAT_REPORT_TOOLS`) and by `POST /api/projects/:id/executions`; `GET
  /api/projects/:id/executions/:executionId` reads one back to the person who asked it. Its checks run
  in this order, each refused by name and none reaching an adapter: an executor enabled at all; the
  asker's `assistant.exec` (admin's by default, token-explicit, so a turn token, whose grant is named,
  never holds it, and a personal token holds it when granted Full or naming it); in chat, a web room about the project (an external door is
  `EXECUTION_DOOR_FORBIDDEN`); the project document's `compute.enabled` (absent is off,
  `EXECUTION_DISABLED`); the limits (`EXECUTION_MAX_LIMITS`, never lowered silently); the turn's caps
  (`EXECUTION_TURN_CAPS`: 8 calls, 120 s of wall time, 2 MB of output); the inputs, each a run the
  asker made (in chat, one this turn's `forge_report` or `forge_template` returned; over REST, one
  read in the last ten minutes); the project's data policy on the new egress surface `report.exec`
  (operational: refused at `no_egress`, scrubbed at `redact`), then `scrubSecretsDeep`; and an
  adapter that `compute.zdrOnly` and `compute.thirdParty` admit (a third-party adapter needs
  `thirdParty: true`; unset is refused like `false`; data that stays with Forge or on the team's
  runner needs neither) and that can take it now (`availableFor` answers `true` or why not). None
  admitted is `EXECUTION_NO_ADAPTER_ALLOWED`; admitted but none able is `EXECUTOR_UNAVAILABLE`,
  each naming why every adapter is out.
- **Script I/O.** `EXECUTION_IO` in the contract fixes how every adapter hands a script its inputs
  (`ctx.inputs`) and takes frames back (the script returns `{ frames }`, read by `framesFromReturn`),
  so a script runs alike on each.
- **Record.** `report_executions` (migration 0465) keeps the room or the turn's credential, who asked,
  the adapter, the script and `script_fingerprint` (sha256 of `normalizeScript`: line endings,
  trailing and inner runs of whitespace and blank lines do not change it; indentation does), the input
  run ids, limits, exit, the limit that stopped it, duration, frames (dropped whole past
  `limits.outputBytes`, with the stop named), logs (16 KiB each, scrubbed) and every Forge read
  with its status (`reads`, migration 0471), for 30 days; the
  nightly retention pass sweeps it. An adapter's answer off `ExecutionResultSchema` is
  `EXECUTOR_FAILED` and is not kept.
- **Blocks and grounding.** `forge_show` draws a frame of an execution with `source: { executionId,
  frame? }`; the stored block carries the execution's adapter, language and time beside it, its text
  says it was computed, and web labels it so. `figures-grounded` counts an execution's frames as a
  run's (`reports/executions.ts:keptExecutionFrames` beside `keptRunFrames`).
- **Not in C1.** The monthly project cap of the threat table below; a room's inputs limited to what
  every member may read (runs, too, are read as the asker alone today); sharing an answer that holds a
  computed block, which the message share source refuses by name; and the session-page view of the
  record.

### Port 5 — Share: a Forge share link

**Contract** (`packages/contracts/src/shares.ts`, new): `ShareTarget` adapters turn a frozen
`ReportDocument` into something a reader opens. **One adapter, `forge-link`, is built.** The port
exists so a later target (a mail digest, a PDF file) is an adapter beside it; a target that hands
the document to a third-party host (claude.ai artifacts included) is refused by the owner's
ruling and is not registered.

**The `forge-link` adapter:**

- **Scoped.** A link points at one frozen snapshot — a chat answer, a template's output or a
  stored status report — never at a live query, a conversation, or the project. A chat answer is
  shared from any message of its turn and freezes the whole turn: the person's question as the
  document's `title`, the reply as `reply` (Markdown; a partial whose rest followed gives way to the
  rest), and every visual block the turn posted, in order (`packages/core/src/reports/share-source.ts:messageShareSource`
  over `packages/core/src/conversations/answer-turn.ts:readAnswerTurn`). No tool input or output is
  ever frozen.
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
  token-explicit per ADR 0007: a Full token holds it where its holder does, a named one where it
  names it).
- **Expiring.** `expires_at` is required: default 7 days, at most 30.
- **Revocable.** The creator or a `project.admin` revokes it, effective on the next request. A share
  stands only while its creator still holds the permission that created it (`shares.write`, or
  `shares.public` for a `link` share), read on every open, so a creator who leaves the project or
  loses that permission stops their links on the next request.
- **Offered, never guessed.** `GET /api/projects/:id/shares/audiences` answers each audience as open
  or with the refusal creating it would answer, from the same checks
  (`packages/core/src/shares/service.ts:shareAudienceOptions`). The web's Share action on an
  answer — on any message of an assistant turn — reads it before offering "Anyone with the
  link", shows the link once, and Project settings → People lists and revokes the project's links
  (`packages/web-v2/src/features/shares/components/share-list.tsx:ShareList`).
- **Read-only.** The page `/s/[token]` draws the snapshot as data — titled by the document's own
  title, else its built-in template's, never a template id; a chat answer's reply as Markdown whose
  links and images are drawn as their words; then each block through the web block registry
  (`packages/web-v2/src/features/shares/components/shared-answer.tsx:ReportDocumentBody`) — with no
  actions, no navigation and no live reads; `ref` cells render as text, not links.
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
  `forge_template` (run a template), `forge_template_save` (keep a template run, next items) and, in
  Phase C, `forge_compute` (run an execution) join
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
  over its words or stating a number no block of the template shows is refused by name. A block
  shows what `packages/contracts/src/visual-blocks.ts:shownFrame` answers: the fields it draws over
  the rows it draws. A figure a run holds in a field no block draws is refused too (ISS-419): the
  narrative is read beside the blocks, in the chat, a kept report, its export and a share, and none
  of them shows the run itself. Naming the run in the narrative is not taken in its place, because
  no reader can open a run by its name. Agent mode reaches both
  over `POST /api/projects/:id/report-templates/:templateId/runs` and `.../narrative`.
- **Sharing a template output.** The `template-output` subject is `<templateId>:<runId>,<runId>`
  (`reports/template-share-source.ts`); each run is read again as the creator. That subject keeps no
  narrative, so a shared output carries its blocks and runs with every slot empty; a narrative is
  shared by saving the run first (next item).
- **Saving and scheduling a template run (B3).** `status_reports` holds either a project status read
  or a template's `ReportDocument` (`template_id`, `template_version`, `document`; migration 0463),
  immutable either way. `POST /api/projects/:id/status/reports` with `{ templateId, runIds, narrative? }`
  and the Assistant's `forge_template_save` both go through one service
  (`packages/core/src/status-reports/save.ts:saveTemplateReport`), which judges the narrative with
  `checkTemplateNarrative` and keeps the document, so the narrative is stored with who saved it; it lists in the same history as the status reads, exports through core
  (B4, below), and is removed by its author or a project admin. A
  `status_report` schedule with `params.templateId` runs the template for its owner on each fire and
  stores the output with its narrative (`status-reports/narrative.ts:writeFireNarrative`): after the
  runs are stored, one model call is given the template's slot guidance and what each of this
  fire's blocks shows of its runs, and nothing else from the project, and its answer is judged by
  `checkTemplateNarrative`.
  A refused answer gets one retry carrying the refusal text. The call goes through
  `integrations/llm/chat.ts:completeOnce`, the chat turn's own `openChat` path, so the deployment's
  provider and the project's data policy apply as they do to chat: a `no_egress` project gets no call.
  It writes in the project's content language (`readContentLanguage`), English by default. Each call's
  model and tokens go to `usage_records` (source `api`, `agent-sessions:recordModelCallUsage`). Which
  path ran is kept on the report (`narrative_outcome`, migration 0464; `StatusReportNarrative`:
  `written`, `retried`, or `not_written` with the reason), and a narrative not written leaves the slots
  empty and the notice says why (`Summary not written: <reason>`,
  `packages/contracts/src/status-reports.ts:narrativeOutcomeLine`). The `status-report` share subject
  (`status-reports/share-source.ts`) freezes the kept document, so a shared saved report carries its
  narrative; a kept project status read is refused by name.
- **Exporting a kept template report (B4).** Core alone builds every export, at
  `GET .../status/reports/:reportId/export`: Markdown by default (`reportDocumentMarkdown`: the
  narrative outcome line, the narrative, each block's `toText`, then the slots nobody wrote named with
  why, `unwrittenNarrativeLine`), or `?format=csv&block=<index>` for one `table` block
  (`packages/contracts/src/visual-blocks.ts:tableCsv`: RFC 4180, CRLF, a UTF-8 byte order mark, a
  heading row of the column labels, the rows the table shows; a text cell a spreadsheet would run as a
  formula opens with an apostrophe). A block that is not a table, or not there, is refused naming the
  report's table blocks. The page downloads what the route answers: Export, and a Download CSV beside
  each table and in its Open wide view; it builds no file itself. The saved report shows the same
  outcome line. A `status` cell reads as its sentence-case label everywhere
  (`packages/contracts/src/report-queries.ts:stateLabel` over `REPORT_VOCABULARY_LABELS`, the
  domain's own label maps the web badge reads), so `toText` and the CSV never print a stored token.
  A kept report and `/s/[token]` print as the report alone: the print block in
  `packages/web-v2/src/app/globals.css` drops what a page marks `data-print="chrome"`, every action
  carries `print:hidden`, a table row never breaks across a page and a table prints all its rows.
- **Grounding a figure.** `MessageFacts` (`packages/core/src/messaging/facts.ts:FigureFacts`) carries
  the values of the turn's report runs: every run a result of this turn or a block it drew names by
  id, read from `report_runs` through the `reportRunFrames` message read
  (`packages/core/src/reports/runs.ts:keptRunFrames`), its own project's and unexpired only. The rule
  `figures-grounded` (`packages/core/src/messaging/figures-rule.ts`) refuses a reply whose prose
  states a percentage, a ratio, a count of tracked things or days, a count of a state or a total
  that no such run holds, quoting the figure; and any number typed into a block's title or labels,
  flow labels included. Where the door shows the answer's blocks, a run's figure must also be one a
  block of the answer shows (ISS-419), or it is held asking for the block that shows it. A figure is
  also grounded by the result of a read the rule declares (`FIGURE_GROUNDING_RESULTS`: the project
  status, requirement, release and metrics reads, the BA doors' requirement, dedup and journey
  reads, and the `preview` and `taken` count `forge_requirement_draft` took from an attached
  document; ISS-421), counts of the lists those reads returned included, never by a tool that
  answers with what the model sent it, nor by a refused call. Dates, ids, versions, ordinals and
  quoted sources are exempt, and a number the person typed only said back as theirs, by the table in
  `figure-exemptions.ts`. It judges every chat reply screened with its question, whatever tools the
  turn was offered: the BA door offers no report tool and is held to its reads (ISS-446), and an
  Agent session's REST runs are read from its tool results. A block whose frame differs from
  its run's is refused when it is attached (`packages/core/src/reports/figures.ts:figuresNotInRun`),
  and so is a block whose title or labels state a number its own run does not hold, by the same
  check the screen holds a block's text to
  (`packages/core/src/messaging/figures-rule.ts:ungroundedBlockFigures`), so the model corrects it
  inside the turn.
  `status-claims-rule.ts` counts the report tools as grounding every claim family but a decision;
  `creation-claims-rule.ts` refuses "I shared this", a share link, or a claim that a report was
  saved, read as the act in any phrasing ("its results are saved in the report history", "Saved the
  report…", and the Vietnamese forms; ISS-422), where the turn made no share (`POST /api/projects/:id/shares`)
  or save (`forge_template_save`, or the status-report POST), and no unverified mark exempts a claim
  to have written a record. A reply the screen holds with no rewrite passing goes out as a line that
  names what it stated that nothing backed (`conversations/fallback-replies.ts:heldFallbackReply`),
  never as a check that could not run (ISS-420); where a check the reply needed truly could not run
  (the progress snapshot was not computed), the line names that check and why, and never says
  nothing failed (`RuleBreak.unchecked` in `packages/core/src/messaging/contract.ts`).
- **A block waits on its reply.** A block is never written into the room when it is drawn: it is
  staged outside `conversation_messages`, so neither the room's REST read nor its socket can show
  it, and is posted just above the reply only once that reply passes the reply check. A chat turn
  stages on a per-turn stage handed to `forge_show` (`packages/core/src/assistant/turn-stage.ts`);
  each attempt is screened with the blocks it drew, the reply that goes out releases its own
  answer's blocks through the web transport, and every other block is dropped and named under
  `droppedBlocks` in the window's record — a rewrite keeps a block by drawing it again, as its
  corrective instruction says. An Agent-mode turn's `POST /api/conversations/:id/blocks` answers 202
  and stages on its session's marker (`packages/core/src/reports/rest-stage.ts`); the bridge
  screens the reply with those blocks, releases them with a reply that passes, keeps them on a held
  reply, where only its asker reads them under "Show the held reply", and names them under
  `droppedBlocks` when no reply goes out. A turn token whose block cannot wait — an assistant turn's,
  a session that is gone, another room, a reply already taken — is refused by name. A turn that
  outruns 90 seconds closes its window on a partial reply with `continuing: true` and the bound
  `continuesUntil` (its ceiling, 30 s for a handle past its abort, 30 s for delivery); the rest's
  decision and its `droppedBlocks` are written onto that record as `continued`
  (`packages/core/src/assistant/route-window.ts:recordContinuation`), or `undetermined` at the bound.
- **A turn's draft and tool calls reach its asker alone.** While a turn runs, the person it acts as
  is sent the stream in full, the draft labelled "Draft, not yet checked" until the verdict frame
  swaps it for the reply that went out or takes it back; every other reader is sent only that it
  works and its tools by name and time. The split is taken at the fan-out
  (`packages/core/src/assistant/conversation-adapter.ts:publishEphemeralByViewer`), never in the
  web. An Agent-mode turn's session — transcript, listing, live frames — is its asker's alone, an
  admin included (`packages/core/src/agent-sessions/session-access.ts:conversationTurnAskerOf`).
  Standards: Slack's `chat.postEphemeral` shows a message to one user in a shared channel, and
  Teams streams a bot's reply in one-on-one chats only, a group seeing the finished message.
  Divergence: a group room here streams to its asker, and shows the others tool names, which Teams
  shows nobody. The delivered reply keeps the same split: its delivery records whose turn it was
  (`delivery_proof.askedBy`), and every read that hands a message out
  (`packages/core/src/assistant/read.ts:roomTail`) gives its tool inputs and outputs, its act buttons
  and its reasoning text to that person alone, and to anyone else the tools by name and time
  (`packages/core/src/conversations/tool-content.ts:toolContentFor`). A reply stored before the
  asker was recorded shows its tool content to nobody.
- **A partial reply says what the turn read, in words.** The message a turn posts at its first
  ceiling counts its reads by tool ("ran 3 reports, drew 2 tables") and names its writes with the
  keys they returned; it never quotes a call's arguments or result
  (`packages/core/src/assistant/turn-partial.ts:partialReplyText`).
- **Executor output is untrusted.** A frame from an execution carries `source: { executionId }`,
  is labelled as computed in the block (and in its text, `reports/blocks.ts:attachVisualBlock`), and
  never drives a write without the person's confirmation (REQ-30 BC-4).

## Module boundaries and dependency direction

| Module | Kind | Context | Owns | Imports |
|---|---|---|---|---|
| `report-queries` (new) | read-model | operations | nothing; `reads` declared per query | project-status, forecast, workflows, requirements, feedback read files; contracts |
| `reports` (new) | domain | operations | `report_runs`; Phase B `report_templates` | contracts, kernels, platform; queries and executors **only through its ports** |
| `shares` (new) | domain | operations | `share_links` | `reports`' face; permissions; `lib/data-egress.ts` |
| `runners` | kernel | execution | unchanged | unchanged |
| `assistant` | domain | conversations | unchanged | unchanged: tools arrive by `provideChatTools` |
| `mcp` | door | platform | — | registers the new tools (the only importer of `tool.ts`) |
| web `visual-blocks` (new) | web feature | — | — | contracts; recharts, xyflow, elkjs through the existing design wrappers |

The process entry (`packages/core/src/index.ts`) composes: it provides `report-queries`' registry
to `reports`, the executor adapters to `reports`, and the tools to the assistant — the Backstage
direction: the consumer declares the slot, the adapter registers, the root wires.

**What must not happen** — each is refused by `check-module-boundaries`, `check-provider-literals`
or a review, and none is waived:

- assistant code importing a vendor SDK, a vendor's types or a vendor tool name for rendering or
  execution;
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
| B3 templates in status-reports | a stored report holds a `ReportDocument`; the `status_report` schedule takes `templateId` and its fire has a model write the narrative | **yes: `status_reports` gains template id, version and document (0463), and how a fire's narrative was written (0464)** |
| B4 export | Markdown from `toText`, CSV per `table` block, a print stylesheet for PDF | none |
| B5 doors | external chat doors (Rocket.Chat) post `toText` with a member link | none |
| B6 more templates | weekly delivery, requirement coverage, feedback digest | none |

### Phase C — executor adapters, promotion

| Lane | Delivers | Migration |
|---|---|---|
| C1 executor port and record (built; no adapter yet) | registry in `reports`, `forge_compute`, `assistant.exec`, per-turn caps, the execution record | **yes: `report_executions` (0465)** |
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

An adapter brings its own threat model for where it runs. The port adds:

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
- **`figures-grounded` will refuse some honest replies**: a count worked out from a run (how many
  rows are in one state) is no value of its frame, and a run's figure no drawn block shows is held
  until the block is drawn; every false refusal costs a rewrite turn.
- **A `link` share is egress by design**: once opened, a snapshot cannot be called back from a reader
  who saved it; revocation only stops further views.
- **Computation runs only while the team has a box for it**: with no Linux box with bubblewrap
  connected and bound to the project, every computation is refused by name; and a script sees the
  box's own `python3` and libraries, not a pinned image.
- **Agent mode reaches blocks only over REST**, so a resident session has to be taught the block verb
  through its guide, and until then its replies stay prose.
- **No third-party hosting** means Forge carries the page, the expiry sweep and the abuse controls
  that a hosted artifact service would have carried.
