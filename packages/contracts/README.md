# @forge/contracts

Shared TypeScript types and registries derived from [`@forge/core`](../core) — Drizzle row inferrals, the `z.infer` of the request validators core uses at the HTTP boundary, and the constants and Zod schemas a client needs at runtime. The request shapes are exported as *types only* (no runtime Zod), so clients get the same compile-time contract without bundling core. Core's own values are not imported at runtime here: a constant a client needs is declared in this package instead.

The point: every client (`web-v2`, `core`, future SDKs) imports the *same* shapes core actually serves, instead of hand-rolling typings that drift.

## Install

Workspace-internal — already wired through pnpm's workspace protocol. To add it to a sibling package:

```json
{
  "dependencies": {
    "@forge/contracts": "workspace:*"
  }
}
```

## Usage

```ts
import type { Issue, Project, IssueCreateInput } from "@forge/contracts";
import { pipelineRegistryResponseSchema } from "@forge/contracts";

// Row types — what core returns from SELECT.
const issue: Issue = await api.get(`/issues/${id}`);

// Request input types — compile-time shape of POST bodies, shared with core
// (these are `z.infer` of core's validators, exported as types — no runtime Zod).
const body: IssueCreateInput = { title: "add /api/foo" };
await api.post("/issues", body);

// Response schemas that carry runtime Zod, like the pipeline-registry one, are parsed on the client.
const registry = pipelineRegistryResponseSchema.parse(await api.get("/pipeline/registry"));
```

## Layout

Every file below is re-exported from [`src/index.ts`](./src/index.ts), the aggregated barrel. Nine of them are also reachable by their own subpath (`@forge/contracts/failure-causes`, `/pipeline-registry`, `/issue-vocabulary`, `/notifications`, `/attachments`, `/deploy-capability`, `/status-sets`, `/work-state`, `/document-patch`), named in `package.json` `exports`; `attachments` and `document-patch` are the two compiled to `dist` by `build` (`tsconfig.emit.json`), and the rest are served from `src`.

| File | Exports |
|---|---|
| [`src/rows.ts`](./src/rows.ts) | Row types inferred from Drizzle table schemas in `@forge/core`, and the hand-typed shapes built over them |
| [`src/requests.ts`](./src/requests.ts) | Request input types (`z.infer` of core's validators, re-exported as types — no runtime Zod) |
| [`src/responses.ts`](./src/responses.ts) | Response envelope shapes |
| [`src/admin.ts`](./src/admin.ts) | Admin overview types, re-exported from core |
| [`src/assistant-self.ts`](./src/assistant-self.ts) | An agent's self record and its presence configuration |
| [`src/attachments.ts`](./src/attachments.ts) | The MIME lists a browser stages attachments against, and the attachment-name rules |
| [`src/body-components.ts`](./src/body-components.ts) | Body format and node types, and the parsed and rendered body shapes |
| [`src/deploy-capability.ts`](./src/deploy-capability.ts) | Which integration providers can deploy (`DEPLOY_CAPABLE_PROVIDERS`, `providerCanDeploy`) |
| [`src/divergence-charters.ts`](./src/divergence-charters.ts) | Divergence Charter — a project's recorded, intentional deviations from the template (ISS-800); Zod schemas and their types |
| [`src/document-patch.ts`](./src/document-patch.ts) | The write contract for a stored settings document: a `base` beside a sparse `patch`, applied whole or refused whole |
| [`src/domain-templates.ts`](./src/domain-templates.ts) | The static catalog of built-in domain templates for the project chat-agent settings (`DOMAIN_TEMPLATES`) |
| [`src/failure-causes.ts`](./src/failure-causes.ts) | The closed list of failure causes (`FAILURE_CAUSES`) and how each is presented |
| [`src/forge-record.ts`](./src/forge-record.ts) | The view of a typed record, in the product or the technical lens |
| [`src/integrations.ts`](./src/integrations.ts) | Cross-app integration types |
| [`src/issue-vocabulary.ts`](./src/issue-vocabulary.ts) | The autonomous labels and the kernel status each is written as |
| [`src/issues.ts`](./src/issues.ts) | Release-notes types (`ReleaseNotes`, `ReleaseNotesSection`) re-exported from core |
| [`src/notifications.ts`](./src/notifications.ts) | Notification types, kinds, tiers and per-type contracts |
| [`src/park.ts`](./src/park.ts) | The views of a parked issue: what it owes, where it resumes, its answer |
| [`src/pipeline-registry.ts`](./src/pipeline-registry.ts) | Pipeline-registry response (`pipelineRegistryResponseSchema`) plus the enum tuples it hardcodes rather than importing core's |
| [`src/reconcile.ts`](./src/reconcile.ts) | Reconcile run / verdict / verifier-vote schemas and types (ISS-795 update pipeline) |
| [`src/skill-activity.ts`](./src/skill-activity.ts) | Skill-update activity-log event schemas and types (ISS-797) |
| [`src/skill-facts.ts`](./src/skill-facts.ts) | Skill-facts schemas and types, with the category, tier, scope and namespace tuples |
| [`src/ssh-keys.ts`](./src/ssh-keys.ts) | Org Private Keys pool + per-project git-credential types |
| [`src/status-sets.ts`](./src/status-sets.ts) | The browser's copies of the status sets core owns, each held to core's by a parity test |
| [`src/update-packets.ts`](./src/update-packets.ts) | Update Packet artifact + its mandatory `story` field (ISS-799) |
| [`src/work-state.ts`](./src/work-state.ts) | The state of work (`WORK_STATES`) every screen that counts or groups issues reads, and the status-to-state fold |
| [`src/index.ts`](./src/index.ts) | Aggregated barrel |

## Why "type-only" for core's shapes

`@forge/contracts` depends on `@forge/core` to *read* its schemas, through `@forge/core/public` and `@forge/core/admin-types`, and imports only types from it: request inputs are `z.infer`-derived, not runtime validators. The runtime values it does ship — the pipeline-registry, skill-facts, divergence-charter, reconcile, update-packet and skill-activity schemas, and the constants listed above — hardcode their own enum tuples rather than importing core, which has environment side effects at import time. Where a value is a second declaration of one core owns, a parity test in core holds the two identical (`packages/core/src/db/status-sets-parity.test.ts` for the status sets). Web-v2 never bundles core code at runtime. Changing core handlers without changing schemas leaves contracts untouched — which is the desired property.

→ When core changes a row or request shape, add or update the export here and the consumer packages get TypeScript errors at the call sites that need updating. That's the contract.
