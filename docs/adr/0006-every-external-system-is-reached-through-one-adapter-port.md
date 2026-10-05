# 0006 — Every external system is reached through one adapter port

**Status:** accepted · **Date:** 2026-10-04 · **Supersedes:** none

## Context

The owner asked on 2026-10-04 that Forge's external systems be organised as adapters: if the code
really ran the way the system context drew it, the design was too tangled to be a stable pattern.
Both halves were partly true.

`packages/core/src/integrations/` already held ten project-bound adapters — autoflow, coolify,
epodsystem, github, gitlab, google, postman, rocketchat, sentry and the source-host port over
github and gitlab — each reached through `packages/core/src/integrations/registry.ts` with its credential in the
vault. Read at `bbc4cb809` on `dev`, these reached an external system from domain code instead.

Each row names the module as it was then, in plain text because it has since moved, and where its
call sits now.

| Then (under core's `src`) | Now | What it called |
|---|---|---|
| memory/llm.ts | `packages/core/src/integrations/llm/fast-model.ts` | LiteLLM `chat/completions` with the global `fetch` — **outside the data-egress guard**. So did every memory and knowledge embedding; only `packages/core/src/knowledge/item-embeddings.ts` and `packages/core/src/requirements/embeddings.ts` gated their text |
| assistant/providers/*, and the token counter in assistant/tool-catalog-cost.ts | `packages/core/src/integrations/llm/` | the chat model (OpenAI-compatible and Anthropic Messages) and Anthropic's `count_tokens` |
| embeddings/client.ts, embeddings/index.ts | `packages/core/src/integrations/llm/embeddings.ts`, `packages/core/src/integrations/llm/embeddings-client.ts` | the embeddings endpoint |
| the transports in auth/email.ts and projects/invitation-email.ts | `packages/core/src/integrations/identity/smtp.ts` | two `nodemailer` transports, built twice from the same `SMTP_*` |
| auth/oauth/github.ts, oidc-discovery.ts, oidc-provider.ts | `packages/core/src/integrations/identity/` | GitHub OAuth, Google and generic OIDC |
| webhooks/outbound.ts | deleted in ISS-220, with no subscriber left | a customer's webhook URL |
| install/fetch-release.ts, install/main-runner-head.ts | `packages/core/src/integrations/github/published-releases/fetch-release.ts`, `packages/core/src/integrations/github/published-releases/main-runner-head.ts`, over `packages/core/src/integrations/github/published-releases/public-releases.ts` | `api.github.com` releases and commits |
| the download in ecosystem/contract/oasdiff.ts | `packages/core/src/integrations/github/published-releases/public-releases.ts` | a pinned binary download from `github.com` — not a remote spec |
| lib/runtime-probe.ts, and the global `fetch` the environment-state read handed it | `packages/core/src/integrations/deploy/runtime-probe.ts` | a project's deployed app, through its declared runtime probe — found by the rule below, not by the hand list |
| schedules/script/worker-entry.ts | no port: a call of `ctx.http.fetch` is refused, naming it | whatever URL a user's sandboxed script names |
| lib/sentry.ts | `packages/core/src/integrations/sentry/own-errors.ts`, behind the error-tracking port `packages/core/src/lib/error-tracking.ts` | Forge's own crash reports, through `@sentry/node` |

The dev and prod compose files name the same set from the deployment side: `SMTP_*`, `LITELLM_*`,
`ANTHROPIC_*`, `EMBEDDINGS_*`, `GITHUB_OAUTH_*`, `GOOGLE_OIDC_*`, `OIDC_*`, `SENTRY_DSN` and
`RUNNER_RELEASE_*`/`GITHUB_TOKEN`. None of those had an adapter.

## Decision

**Each external system is reached through exactly one adapter under
`packages/core/src/integrations/<port>/`.** A domain depends on the port's typed functions, never on
a vendor SDK, a `fetch` to a vendor host, or a vendor's types.

**Ports are named by role, not by vendor**, and a port may hold several vendors:

| Port | Directory under `integrations` | Vendors | Bound to |
|---|---|---|---|
| source hosting | `source-host` over `github`, `gitlab` | GitHub, GitLab | a project's binding |
| deploy | `coolify`, `deploy`; the contract is `packages/core/src/integrations/deploy/records.ts` | Coolify; a deployed app's runtime probe | a project's binding |
| error tracking | `sentry` | Sentry | a project's binding |
| storefront | `epodsystem`, `autoflow` | ePodSystem, Autoflow | a project's binding |
| chat | `rocketchat` | Rocket.Chat | a project's binding |
| LLM | `llm` | any OpenAI-compatible endpoint (LiteLLM), Anthropic Messages | the deployment |
| embeddings | `embeddings` | any OpenAI-compatible endpoint | the deployment |
| mail | `mail` | SMTP | the deployment |
| identity | `identity` | GitHub OAuth, Google, generic OIDC | the deployment |
| paired runner box | `published-releases`, for the published build; the box itself dials in | GitHub releases | the deployment |

The same vendor may serve two roles — GitHub hosts source and signs people in — and is then two
adapters, one per port. `packages/core/src/integrations/README.md` holds this table with each port's callers, and is
where a new port is added.

**A project-bound port is reached through the registry** (`packages/core/src/integrations/registry.ts`), with its
credential in the vault. **A deployment-bound port** reads its configuration from the environment
and exports plain functions; it has no registry entry, because no project chooses it.

**The LLM and embedding ports call the data-egress guard inside the adapter.** `callFastModel`,
`embed`, `embedBatch`, `embedQuery` and `embedWithModel` take an `EgressScope` — the surface the
text belongs to, plus its project or level when the surface is operational — and run
`packages/core/src/lib/data-egress.ts:egressScoped` before any byte leaves. The type makes the scope required, so a
caller cannot forget it; a product surface needs no level, because product content leaves as
stored at every level. Three surfaces were declared for this — `memory`, `knowledge` and
`agent-session`, all product — which keeps today's behaviour at every level; classing any of them
operational is a data-policy decision, and the type would then demand a project from every caller.

**The rule is held by a scan, in seconds.** `scripts/check-provider-literals.mjs` already decided
where a provider may be *named*; it now also decides where core may *call out*: a global `fetch`
(called, or handed on as a value) or an import of a package in `egress.vendorSdks`, in any core file
outside `packages/core/src/integrations/`, is refused by file and line. Its configuration is
`.forge/conformance.json` → `checkers["provider-literals"].egress`, every exception carries the
sentence that justifies it, and an exception with no reason is refused.

### The named exceptions

- **`packages/core/src/schedules/script/worker-entry.ts`** — the sandboxed schedule script's `ctx.http.fetch`
  had no system for a port to name and no egress policy to pass, so it is refused by name rather
  than left as an open fetch of any `https:` URL.
- **Forge's own crash reporting** leaves through the error-tracking port,
  `packages/core/src/lib/error-tracking.ts`; the adapter installed behind it at boot,
  `packages/core/src/integrations/sentry/own-errors.ts`, is the one module importing `@sentry/node`.
- **The runner protocol** (the `ws`, `devices` and `runners` modules of core) is not under `integrations`: the paired box
  dials in to Forge over Forge's own contract in `packages/contracts`, so nothing there reaches out.
- **The oasdiff binary** (`packages/core/src/ecosystem/contract/oasdiff.ts`) is a local process the
  contract differ runs over two specs it already holds; it reaches no system. Only its pinned
  download crosses a boundary, and that sits in `packages/core/src/integrations/github/published-releases/public-releases.ts`.
- **Object storage** is not an external system today: `STORAGE_DRIVER` accepts only `local`, and `s3`
  is refused by name. A driver for an object store would be an `object-storage` port under `integrations`.

## Consequences

- Every bypass in the table above now sits behind its port; the scan reads zero offenders.
- **Two priced amnesties were left**, each with the condition that ended it:
  - Callers of the crash-reporting module took the vendor's `Sentry` namespace from it (18 core
    files outside `integrations`, read on 2026-10-04). Closed by ISS-167: the module exports role-typed
    functions (`reportFailure`, `reportCondition`, `traceStep`, `flushReports`) and no caller names `Sentry`.
  - Three domain files called a vendor directory where a source-hosting port exists (and by
    2026-10-04 seven did: the runner box's published build and the oasdiff download were reached in
    `github/` too). Closed by ISS-167: the change request projection, its health reading and the
    opened-pull-request record are `source-host` functions, the review note is the comments domain's,
    `webhooks/github-adapter.ts` is gone, and the published-build reads and the pinned download sit in
    the `published-releases` port. Every domain file reaches a port through its **index.ts**.
- The existing vendor directories keep their names. Renaming them under role directories would
  touch the registry's provider keys, every provider-literal allowance and several hundred imports,
  for no behaviour; the role each serves is declared in the integrations README, and a new vendor
  goes under its role.
- The chat transcript's egress stays where it is: `packages/core/src/assistant/external-chat.ts:runExternalChatTurn`
  and the BA tools gate the spoken messages and each tool result before calling the LLM port's
  `stream`. The port takes them already gated because the guard has to tell the system prompt from
  what people said, which only the turn knows.
- Not decided here: web-v2's own `fetch` to Forge's API and its browser Sentry DSN. Neither is core
  reaching an external system.
