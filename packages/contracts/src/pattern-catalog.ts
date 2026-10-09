// Generated from docs/patterns/*.md by `node scripts/check-pattern-catalog.mjs --write`: edit the
// pages, never this file. `pnpm verify` (check-pattern-catalog) refuses it when it disagrees with them.

import type { PatternEntry } from "./patterns.js";

/** The pattern catalog of this repository, one entry per page (REQ-36 BC-4). */
export const PATTERN_CATALOG: readonly PatternEntry[] = [
	{
		slug: "api-route",
		title: "API route",
		changeKind: "API route",
		page: "docs/patterns/api-route.md",
		introducedBy: "ISS-466",
		reference: [
			"packages/core/src/suggestions/routes.ts",
			"packages/contracts/src/suggestions.ts",
			"packages/core/src/suggestions/service.ts",
			"packages/core/src/suggestions/rules.ts",
			"packages/core/src/middleware/zod-validator.ts",
			"packages/core/src/lib/refusal.ts",
			"packages/core/src/route-registry.ts",
			"packages/core/src/credentials/pat-permissions.ts",
			"packages/core/contracts/forge-api.openapi.json"
		],
		tests: [
			"packages/core/src/suggestions/rules.test.ts",
			"packages/core/tests/integration/contract-waits-e2e.test.ts",
			"packages/core/tests/integration/"
		],
		checklist: [
			"The route file holds no database call and no rule: it validates, calls one service or read function, and answers.",
			"The body is a `z.strictObject` from contracts read through `strictBody` with its SHAPE string; path and query go through `zValidator` with a message naming what is valid.",
			"Every refusal is a code declared in contracts, answered in the envelope through `refused`, with a status that says what the client should do.",
			"The service asks `can()` for the permission the act needs; the route reads no role, grant or token itself.",
			"A new prefix is listed in `PAT_PERMISSION_RESOURCES`, and the router is mounted only in **route-registry.ts**.",
			"`forge-api.openapi.json` (and `forge-mcp.tools.json` where a tool changed) is regenerated in the same change.",
			"A write answers what it changed; a list answers summaries and a whole document comes only from a get.",
			"A refusal's detail names what was wrong and what is valid, and names another entity by its key, never by uuid.",
			"A wrong input is refused by name; no schema was widened and no compatibility branch added to accept it."
		]
	},
	{
		slug: "assistant-tool",
		title: "Assistant tool",
		changeKind: "Assistant tool",
		page: "docs/patterns/assistant-tool.md",
		introducedBy: "ISS-466",
		reference: [
			"packages/core/src/assistant/tools/registry.ts",
			"packages/core/src/assistant/tools/forge-memory-note-tool.ts",
			"packages/core/src/memory/tool.ts",
			"packages/core/src/mcp/registry.ts",
			"packages/contracts/src/mcp-tools.ts",
			"packages/core/src/mcp/chat-read-tools.ts",
			"packages/core/src/lib/tool-call-guard.ts",
			"packages/core/src/lib/tool.ts",
			"packages/core/contracts/forge-mcp.tools.json"
		],
		tests: [
			"packages/core/src/assistant/tools/await-reply-tool.test.ts",
			"packages/core/src/assistant/tools/forge-memory-note-tool.test.ts",
			"packages/core/tests/integration/ba-suggest-base-e2e.test.ts",
			"packages/core/tests/integration/"
		],
		checklist: [
			"Neither a REST route nor a CLI verb already serves what the tool does; the change says why an agent needs the tool.",
			"The input is one `z.strictObject` whose fields carry descriptions; the tool declares `grant`, `reach` and `route`.",
			"The handler calls the same service or read function as the route and re-implements no rule.",
			"Permission is asked through `requireCan`/`can()` as the turn's principal, never assumed from the session.",
			"The tool sits in its module's **tool.ts** (or **assistant/tools/** for an assistant-only one) and is registered only in the tool registries.",
			"The description tells the model when to call it and when not to, in English, and names no internal file.",
			"Wrong arguments are refused by name with the valid shape; nothing is written on a refusal.",
			"`forge-mcp.tools.json` is regenerated in the same change where an MCP tool changed."
		]
	},
	{
		slug: "core-module",
		title: "Core module",
		changeKind: "Core module",
		page: "docs/patterns/core-module.md",
		introducedBy: "ISS-466",
		reference: [
			"packages/core/src/modules.json",
			"packages/core/src/suggestions/rules.ts",
			"packages/core/src/suggestions/read.ts",
			"packages/core/src/suggestions/service.ts",
			"packages/core/src/suggestions/index.ts",
			"packages/core/src/db/schema-suggestions.ts",
			"packages/contracts/src/suggestions.ts",
			"packages/core/src/lib/refusal.ts",
			"packages/core/src/lifecycle/transition.ts",
			"packages/core/src/runs/facts-read.ts",
			"scripts/check-module-boundaries.mjs",
			"scripts/check-module-shape.mjs"
		],
		tests: [
			"packages/core/src/suggestions/rules.test.ts",
			"packages/core/src/suggestions/revise-accept.test.ts",
			"packages/core/tests/integration/contract-waits-e2e.test.ts",
			"packages/core/tests/integration/"
		],
		checklist: [
			"Every new directory under `packages/core/src` has an entry in `modules.json` with its kind, context and `serves`.",
			"Every new table is listed under exactly one module's `owns`, and only that module writes it.",
			"No import runs against context or kind direction, and another module is reached through its **index.ts** only.",
			"A route file holds no database call and no rule; it validates, calls one service or read function, and answers.",
			"A service returns its refusals; none is thrown as an error class, an `HTTPException` or text, and each code is declared in contracts.",
			"Enum values, refusal codes, request schemas and views are declared once in contracts, and the table's CHECK is built from the same array.",
			"A status is written only through the kernel transition, and a changed machine records a new shape.",
			"A fact another module reacts to is an outbox event with a declared consumer; nothing emits an event nobody consumes.",
			"A derived fact has one function in one read model, and a gate deciding on it calls the same input-builder.",
			"Every check of who may act asks `can()` for a permission in `packages/contracts/src/permissions.ts`.",
			"Code this change replaced is removed in it, and a compatibility path names its issue and the condition that ends it."
		]
	},
	{
		slug: "migration",
		title: "Migration",
		changeKind: "Migration",
		page: "docs/patterns/migration.md",
		introducedBy: "ISS-466",
		reference: [
			"packages/core/drizzle/migrations/README.md",
			"packages/core/drizzle/migrations/0472_a_gated_move_records_its_checklist_and_its_refusals.sql",
			"packages/core/drizzle/migrations/0407_an_issue_waits_on_a_contract_version_not_on_another_issue.sql",
			"packages/core/drizzle/migrations/0450_an_approval_before_its_landing_rule_is_recorded.sql",
			"packages/core/drizzle/migrations/meta/_journal.json",
			"scripts/check-migration-order.mjs",
			"packages/core/src/db/schema-contract-waits.ts"
		],
		tests: [
			"packages/core/src/db/schema-checks.test.ts",
			"packages/core/tests/integration/design-landing-backfill-migration-e2e.test.ts",
			"packages/core/tests/integration/",
			"packages/core/tests/helpers/migration-ground.ts"
		],
		checklist: [
			"The index and `when` are the `Next free:` line of **check-migration-order.mjs**, and the journal entry's `tag` matches the file name.",
			"Every statement is idempotent and separated by `--> statement-breakpoint`; the file opens no transaction.",
			"The header says what changes and why, and a ROLLBACK paragraph says what reverting loses.",
			"Every CHECK, index and table is also declared in its `packages/core/src/db/schema-*.ts` module, built from the contracts array or limit it enforces.",
			"A new table is declared in a `packages/core/src/db/schema-*.ts` module, which `packages/core/drizzle.config.ts` reads by its name, and listed under its owner's `owns` in `modules.json`.",
			"Ids, scope columns, timestamps and actor columns follow the Tables rules of the core-module entry.",
			"A row the new shape cannot represent makes the migration abort naming it; nothing is deleted or widened to make it fit.",
			"A state removed from a machine moves its rows with `forge_migrate_state_rows` before the CHECK drops it.",
			"The migration applies over a database holding rows, not only over the empty template."
		]
	},
	{
		slug: "runner-actor",
		title: "Runner actor",
		changeKind: "Runner actor",
		page: "docs/patterns/runner-actor.md",
		introducedBy: "ISS-466",
		reference: [
			"packages/runner/crates/runner-daemon/src/actors.rs",
			"packages/runner/crates/runner-daemon/src/lib.rs",
			"packages/runner/README.md",
			"packages/runner/clippy.toml",
			"scripts/check-runner-gates.mjs"
		],
		tests: [
			"packages/runner/crates/runner-daemon/src/actors/cancel_tests.rs",
			"packages/runner/crates/runner-daemon/src/pool_jobs/tests.rs"
		],
		checklist: [
			"The actor decides nothing core could decide; it reports a condition or carries out an instruction core sent.",
			"It runs on `Ticks` or a frame and ends when its cancel receiver says so; it holds no state another actor writes.",
			"It is spawned once in **lib.rs** with its own cancel receiver clone, and nothing else starts it.",
			"A failure is logged with the actor's tag and the loop goes on; it never panics the daemon or exits silently.",
			"Its first run comes after its first wait, so a restart does not run it twice in a row.",
			"It calls core only through a REST route or answers a frame; no endpoint is invented on the box side.",
			"Functions stay under clippy's limit and files under the gate's limit; `fmt` and `clippy -D warnings` pass.",
			"Anything it leaves on the machine (a pane, a file, a process) is reaped by it or by a named sweep."
		]
	},
	{
		slug: "screen",
		title: "Screen",
		changeKind: "Screen",
		page: "docs/patterns/screen.md",
		introducedBy: "ISS-466",
		reference: [
			"packages/web-v2/src/features/suggestions/api.ts",
			"packages/web-v2/src/features/suggestions/hooks.ts",
			"packages/web-v2/src/features/suggestions/types.ts",
			"packages/web-v2/src/features/suggestions/components/suggestion-list.tsx",
			"packages/web-v2/src/lib/api/refusals.ts",
			"packages/web-v2/src/design/primitives/enum-badge.tsx",
			"packages/web-v2/src/lib/i18n/product-copy.ts"
		],
		tests: [
			"packages/web-v2/src/features/suggestions/components/suggestion-list.test.tsx",
			"packages/web-v2/src/test/en-only-copy.test.tsx"
		],
		checklist: [
			"The feature keeps the module layout: **api.ts**, **hooks.ts**, **types.ts**, **components/**, and **routes.ts** only where it owns pages.",
			"Every fact the screen shows comes from a core read; **derive.ts** only formats, sorts and groups.",
			"Types come from `@forge/contracts`; no shape core answers is redeclared by hand.",
			"A refused write is drawn from the refusal envelope (`refusalsOf`, `namedRefusals`, `RefusalLine`), naming the code's sentence, never a generic error.",
			"Badges use `StatusBadge` or `EnumBadge` with tones from contracts; the feature declares no colour map.",
			"New words are copy keys in English only; none is written inline in the component, and no Vietnamese is added.",
			"A mutation invalidates every query its effect changes.",
			"The screen is reachable: a route or a parent component renders it, and it works at phone width."
		]
	}
];
