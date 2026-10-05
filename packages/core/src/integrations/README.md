# integrations — one adapter per external system

Every external system core reaches goes through a port in this directory
([ADR 0006](../../../../docs/adr/0006-every-external-system-is-reached-through-one-adapter-port.md)).
A domain calls the port's typed functions; it never imports a vendor SDK, calls the global `fetch`,
or names a vendor's types. `scripts/check-provider-literals.mjs` refuses a `fetch` or a vendor SDK
import anywhere else in core, by file and line, and lists the named exceptions it allows.

A **project-bound** port is reached through `registry.ts`, with its credential in the vault and its
binding per project. A **deployment-bound** port reads the environment and exports plain functions.
A domain imports a port's **index.ts**, never a file behind it.

**An adapter imports no domain, kernel or read model** (pattern v2, BC-22). It speaks its vendor's
protocol and nothing else:

- What a vendor delivers is reported, not acted on. `handleInbound` returns `facts` (`types.ts:InboundFact`),
  the webhook door (`integration-door/webhook-inbound-routes.ts`) writes them to the outbox, and the module that owns
  each effect consumes them: `source.pushed` (ecosystem, projects), `source.merged` (issues),
  `source.reviewed` (comments), `error.sighted` (error-intake).
- What an adapter must know about Forge's own rows (a project's declared repository, the issue a branch
  names) is handed in at boot through `forge-reads.ts:provideForgeReads`, never imported.
- A write that must share a transaction with a Forge row takes the caller's writer: the merge verb
  (`source-host/merge.ts:mergeStoredChangeRequest`) is given the issue's stamp by its caller, and a
  deploy dispatch reports its targets to `OutboundDispatchInput.onDeployOutcome`, which the release's
  worker (`release-batch/deploy-worker.ts`) turns into holds and confirmations.
- A vendor connection that stays open hands what it takes in to handlers the owning slices provide at
  boot: the Rocket.Chat connection owner (`rocketchat/connection-manager.ts`) routes a room message to
  `rocketchat/room-handlers.ts:RoomHandlers`, which `assistant/chat-room/room-chat.ts` fills. The
  chat application (conversation ports, window drain, escalation, question and comment lanes) lives
  in `assistant/chat-room/`; their deliveries settle through the kernel
  transition (`@forge/contracts/room-delivery-machine`).
- An adapter holds no HTTP route and no MCP tool. A provider's routes and tools are the integration
  door's (`../integration-door/`, one `<port>-routes.ts` or `<port>-tool.ts` each), which checks the
  caller's permission and calls the port. A change an open view must see is announced through the
  outbox (`integration.changed`, emitted by `project-config:announceIntegrationChanged`).

| Port | Directory | Vendors | Bound to | Called from |
|---|---|---|---|---|
| source hosting | `source-host/` over `github/`, `gitlab/`; the change request projection (`repo_pull_requests`) is the port's | GitHub, GitLab | project | `ecosystem/builder-head.ts`, `execution-ports.ts`, `integration-door/issue-merge-routes.ts`, `integration-door/source-tool.ts`, `integration-door/status-service.ts`, `projects/commit-owners.ts`, `projects/live-reach.ts`, `projects/live-reading.ts`, `projects/live-source.ts`, `work-ports.ts` |
| deploy | `deploy/` (the record contract in `deploy/records.ts`, the runtime probe), `deploy/coolify/` | Coolify; a deployed app's runtime probe | project | `project-config/environment-state.ts`, `release-batch/verify.ts`, `release-batch/coolify-*.ts`, `release-batch/deploy-worker.ts`, `integration-door/coolify-*.ts` |
| error tracking | `sentry/` | Sentry | project | `error-intake/pull.ts`, `error-intake/sightings.ts`, `integration-door/sentry-tool.ts` |
| storefront | `epodsystem/`, `autoflow/` | ePodSystem, Autoflow | project | the registry only |
| chat | `rocketchat/` (the REST and DDP clients, the connection owner, room routing, the thread registry) | Rocket.Chat | project | `assistant/chat-room/*`, `assistant/identity/directory.ts`, `integration-door/routes.ts`, `index.ts` |
| LLM | `llm/`, over the AI SDK (`ai`, `@ai-sdk/openai-compatible`, `@ai-sdk/anthropic`) behind `ChatProvider` | OpenAI-compatible endpoints (LiteLLM), Anthropic Messages | deployment | `assistant/*` (the chat turn and its runner, BA tools, bench judge, catalog cost), `memory/extraction.ts`, `memory/consolidation.ts`, `memory/rerank.ts`, `agent-sessions/auto-title.ts` |
| embeddings | `llm/embeddings.ts`, over the AI SDK's `embedMany` | OpenAI-compatible endpoints | deployment | `memory/*`, `knowledge/*`, `requirements/embeddings.ts`, `knowledge/item-embeddings.ts`, `work-ports.ts`, `memory/tool.ts`, `knowledge/tool.ts` |
| mail | `identity/smtp.ts` | SMTP | deployment | `auth/register.ts`, `projects/invitation-email.ts`, `orgs/routes.ts` |
| identity | `identity/` | GitHub OAuth, Google, generic OIDC | deployment | `auth/oauth/*` |
| paired runner box, pinned downloads | `github/published-releases/` | GitHub releases | deployment | `devices/build-state.ts`, `ecosystem/contract/oasdiff.ts`, `timer-registry.ts`, `index.ts` |

The LLM and embedding ports gate every text through `lib/data-egress.ts:egressScoped` inside the
adapter: their functions take an `EgressScope`, so no caller can send content without naming the
surface it belongs to.

**Adding a system:** name the port by its role, not the vendor; put the vendor under it (or beside
an existing port that already serves the role); add a row here. A project-bound vendor also
registers in `packages/core/src/integration-registry.ts`.
