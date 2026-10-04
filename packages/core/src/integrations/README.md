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
  the webhook door (`webhooks/inbound-routes.ts`) writes them to the outbox, and the module that owns
  each effect consumes them: `source.pushed` (ecosystem, projects), `source.merged` (issues),
  `source.reviewed` (comments), `error.sighted` (error-intake).
- What an adapter must know about Forge's own rows (a project's declared repository, the issue a branch
  names) is handed in at boot through `forge-reads.ts:provideForgeReads`, never imported.
- A write that must share a transaction with a Forge row takes the caller's writer: the merge verb
  (`source-host/merge.ts:mergeStoredChangeRequest`) is given the issue's stamp by its caller.

| Port | Directory | Vendors | Bound to | Called from |
|---|---|---|---|---|
| source hosting | `source-host/` over `github/`, `gitlab/`; the change request projection (`repo_pull_requests`) is the port's | GitHub, GitLab | project | `devices/admissible.ts`, `ecosystem/builder-head.ts`, `ecosystem/contract/land.ts`, `git/remote-divergence.ts`, `issues/commit-landing.ts`, `issues/merge-routes.ts`, `source-host/tool.ts`, `projects/commit-owners.ts`, `projects/live-reach.ts`, `projects/live-reading.ts`, `projects/live-source.ts` |
| deploy | `../project-config/deploy-adapters` (contract), `coolify/`, `deploy/` | Coolify; a deployed app's runtime probe | project | `project-config/environment-state.ts`, `project-config/environment-state-read.ts`, `release-batch/verify.ts`, `coolify/tool.ts` |
| error tracking | `sentry/` | Sentry | project | `error-intake/pull.ts`, `error-intake/sightings.ts`, `sentry/tool.ts` |
| storefront | `epodsystem/`, `autoflow/` | ePodSystem, Autoflow | project | the registry only |
| documents | `google/` | Google Sheets | project | `google/tool.ts` |
| chat | `rocketchat/` | Rocket.Chat | project | `assistant/identity/directory.ts`, `agent-sessions/terminal-effects.ts`, `index.ts` |
| contract testing | `postman/` | Postman | project | `route-registry.ts` (target routes) |
| LLM | `llm/` | OpenAI-compatible endpoints (LiteLLM), Anthropic Messages | deployment | `assistant/*` (the chat turn, BA tools, bench judge, catalog cost), `conversations/turn-runner.ts`, `memory/extraction.ts`, `memory/consolidation.ts`, `memory/rerank.ts`, `agent-sessions/auto-title.ts`, `app-config/routes.ts` |
| embeddings | `embeddings/` | OpenAI-compatible endpoints | deployment | `memory/*`, `knowledge/*`, `requirements/embeddings.ts`, `embeddings/item-writer.ts`, `issues/backlog/alike-source.ts`, `memory/tool.ts`, `knowledge/tool.ts` |
| mail | `mail/` | SMTP | deployment | `auth/email.ts`, `projects/invitation-email.ts` |
| identity | `identity/` | GitHub OAuth, Google, generic OIDC | deployment | `auth/oauth/*` |
| outbound webhooks | `outbound-webhooks/` | a customer's URL | project webhook row | `webhooks/subscribers.ts`, `index.ts` |
| paired runner box, pinned downloads | `published-releases/` | GitHub releases | deployment | `devices/build-state.ts`, `runners/build-comparison.ts`, `ecosystem/contract/oasdiff.ts`, `timer-registry.ts`, `index.ts` |
| runner release publishing | `github/` (`runner-release*.ts`) | GitHub | project | `pipeline/runner-release-deadline.ts`, `route-registry.ts` |

The LLM and embedding ports gate every text through `lib/data-egress.ts:egressScoped` inside the
adapter: their functions take an `EgressScope`, so no caller can send content without naming the
surface it belongs to.

**Adding a system:** name the port by its role, not the vendor; put the vendor under it (or beside
an existing port that already serves the role); add a row here. A project-bound vendor also
registers in `register-all.ts`.
