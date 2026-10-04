# integrations — one adapter per external system

Every external system core reaches goes through a port in this directory
([ADR 0006](../../../../docs/adr/0006-every-external-system-is-reached-through-one-adapter-port.md)).
A domain calls the port's typed functions; it never imports a vendor SDK, calls the global `fetch`,
or names a vendor's types. `scripts/check-provider-literals.mjs` refuses a `fetch` or a vendor SDK
import anywhere else in core, by file and line, and lists the named exceptions it allows.

A **project-bound** port is reached through `registry.ts`, with its credential in the vault and its
binding per project. A **deployment-bound** port reads the environment and exports plain functions.

| Port | Directory | Vendors | Bound to | Called from |
|---|---|---|---|---|
| source hosting | `source-host/` over `github/`, `gitlab/` | GitHub, GitLab | project | `ecosystem/builder-head.ts`, `ecosystem/contract/land.ts`, `git/remote-divergence.ts`, `issues/commit-landing.ts`, `issues/merge-routes.ts`, `source-host/tool.ts`, `projects/commit-owners.ts`, `projects/live-reach.ts`, `projects/live-reading.ts`, `projects/live-source.ts` |
| deploy | `../project-config/deploy-adapters` (contract), `coolify/`, `deploy/` | Coolify; a deployed app's runtime probe | project | `project-config/environment-state.ts`, `project-config/environment-state-read.ts`, `release-batch/verify.ts`, `coolify/tool.ts` |
| error tracking | `sentry/` | Sentry | project | `schedules/sentry-pull-dispatch.ts`, `sentry/tool.ts` |
| storefront | `epodsystem/`, `autoflow/` | ePodSystem, Autoflow | project | the registry only |
| documents | `google/` | Google Sheets | project | `google/tool.ts` |
| chat | `rocketchat/` | Rocket.Chat | project | `assistant/identity/directory.ts`, `agent-sessions/terminal-effects.ts`, `index.ts` |
| contract testing | `postman/` | Postman | project | `route-registry.ts` (target routes) |
| LLM | `llm/` | OpenAI-compatible endpoints (LiteLLM), Anthropic Messages | deployment | `assistant/*` (the chat turn, BA tools, bench judge, catalog cost), `conversations/turn-runner.ts`, `memory/extraction.ts`, `memory/consolidation.ts`, `memory/rerank.ts`, `agent-sessions/auto-title.ts`, `app-config/routes.ts` |
| embeddings | `embeddings/` | OpenAI-compatible endpoints | deployment | `memory/*`, `knowledge/*`, `requirements/embeddings.ts`, `embeddings/item-writer.ts`, `issues/backlog/alike-source.ts`, `memory/tool.ts`, `knowledge/tool.ts` |
| mail | `mail/` | SMTP | deployment | `auth/email.ts`, `projects/invitation-email.ts` |
| identity | `identity/` | GitHub OAuth, Google, generic OIDC | deployment | `auth/oauth/*` |
| outbound webhooks | `outbound-webhooks/` | a customer's URL | project webhook row | `webhooks/subscribers.ts`, `index.ts` |
| paired runner box | `github/fetch-release.ts`, `github/main-runner-head.ts` | GitHub releases | deployment | `devices/build-state.ts`, `runners/build-comparison.ts`, `index.ts` |

The LLM and embedding ports gate every text through `lib/data-egress.ts:egressScoped` inside the
adapter: their functions take an `EgressScope`, so no caller can send content without naming the
surface it belongs to.

**Adding a system:** name the port by its role, not the vendor; put the vendor under it (or beside
an existing port that already serves the role); add a row here. A project-bound vendor also
registers in `register-all.ts`.
