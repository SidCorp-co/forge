# @forge/contracts

Shared TypeScript types and Zod request schemas derived from [`@forge/core`](../core) — Drizzle row inferrals + the same Zod validators core uses at the HTTP boundary. Type-only surface, no runtime coupling beyond imports.

The point: every client (`web`, `dev`, future SDKs) imports the *same* shapes core actually serves, instead of hand-rolling typings that drift.

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
import type { IssueRow, ProjectRow, AgentSessionRow } from "@forge/contracts";
import { createIssueRequest, updateProjectRequest } from "@forge/contracts";

// Row types — what core returns from SELECT.
const issue: IssueRow = await api.get(`/issues/${id}`);

// Request schemas — parse before POSTing, share validation with core.
const body = createIssueRequest.parse({ title: "add /api/foo" });
await api.post("/issues", body);
```

## Layout

| File | Exports |
|---|---|
| [`src/rows.ts`](./src/rows.ts) | Row types inferred from Drizzle table schemas in `@forge/core` |
| [`src/requests.ts`](./src/requests.ts) | Zod request schemas (re-exported from core) |
| [`src/responses.ts`](./src/responses.ts) | Response envelope shapes |
| [`src/domain-templates.ts`](./src/domain-templates.ts) | Reusable domain literal templates (status enums, etc.) |
| [`src/index.ts`](./src/index.ts) | Aggregated barrel |

## Why "type-only"

`@forge/contracts` depends on `@forge/core` to *read* its schemas, but ships only types and zod parsers. Web/dev never bundle core code at runtime. Changing core handlers without changing schemas leaves contracts untouched — which is the desired property.

→ When core changes a row or request shape, add or update the export here and the consumer packages get TypeScript errors at the call sites that need updating. That's the contract.
