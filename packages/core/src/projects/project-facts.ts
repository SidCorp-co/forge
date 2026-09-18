// The reserved `{{project:<key>}}` names, and the sentences the always-inject
// tier owes whoever sets it.
//
// Project prose itself no longer lives here. Until ISS-1048 it was
// `projects.agentConfig.projectFacts`, a kebab-key → free-text map with no type,
// no authorship, no confidence and an injection boolean in a sibling map, while
// `knowledge_entries` modelled the same prose with `kind`, `confidence`,
// `authoredBy`, an embedding and a three-valued `injection` — and the drive
// prompt printed an index of the first while telling the agent to fetch each
// name from the second. Migration 0254 moved every key across; what is left in
// this file is the part that was never prose.
//
// Reserved keys are DERIVED — from project columns, from `environments`, or
// from the connected integrations — and are resolved by
// `prompt/facts/resolve.ts`. Everything else is a knowledge entry, reached with
// `forge_knowledge`.
//
// SECURITY: a reserved value is spliced VERBATIM into the device-installed
// SKILL.md, so it lands on disk. `test-creds` therefore renders a POINTER and
// never the secret.
//
// `production-branch` STAYS reserved after ISS-1046 renamed the column, and it resolves to a
// one-line refusal naming its replacement rather than to a branch or to nothing. A skill body on any
// project may still carry `{{project:production-branch}}`, and nothing in this repo can gate a skill
// body in another one — an unresolved key renders as empty, so dropping the name would delete a
// sentence from an agent's prompt with nobody told.

export const RESERVED_PROJECT_FACT_KEYS = [
  'base-branch',
  'live-branch',
  'production-branch',
  'repo-path',
  'test-urls',
  'test-creds',
  'test-notes',
  'integrations',
] as const;

/**
 * What `{{project:<key>}}` renders for a key outside the reserved set.
 *
 * A refusal and not `undefined`, for the reason `production-branch` is also a
 * refusal: an unresolved reference renders as the empty string, so answering
 * nothing would silently delete a sentence from the prompt of every project
 * whose skill body still splices a guide inline — and no gate in this
 * repository can see a skill body in another one.
 */
export function unreservedProjectKeyRefusal(key: string): string {
  return `⚠️ \`{{project:${key}}}\` resolves to nothing: project prose moved out of \`agentConfig.projectFacts\` into the knowledge store (ISS-1048). Fetch it where you need it with \`forge_knowledge\` (action \`get\`, slug \`${key}\`), and remove this reference from the skill body.`;
}

/**
 * ISS-1048 — the two retired `agentConfig` keys, refused by name on every door
 * that used to accept them.
 *
 * Dropping a key from a non-strict zod object answers the operator's save with a
 * `200` and a silent discard, which is the shape ISS-994 and ISS-1000
 * established and the reason these messages exist rather than a deletion.
 */
export const RETIRED_PROJECT_FACTS_MESSAGE =
  'agentConfig.projectFacts has been removed — project prose lives in knowledge_entries, which models the same text with a kind, a confidence, an author, an embedding and a three-valued injection setting. Write it with the forge_knowledge tool (action `write`), or PUT /api/projects/:id/knowledge/:slug, and remove projectFacts from this request. Migration 0254 already moved every key this project held.';

export const RETIRED_PROJECT_FACTS_CONFIG_MESSAGE =
  'agentConfig.projectFactsConfig has been removed — the always-inject flag it held is now the `injection` field on the knowledge entry itself, which takes `always`, `on_demand` or `none` rather than a boolean in a second map. Set it with the forge_knowledge tool (action `write`), or PUT /api/projects/:id/knowledge/:slug, and remove projectFactsConfig from this request.';

// cm:guard this tier is `mandatory` about DELIVERY and about nothing else — no gate reads the rule back. `ALWAYS_INJECT_GUARANTEE_NOTE` below is the sentence every surface offering the flag owes the owner who sets it, and ISS-936 is why.
// cm:guard the cap is on the SUM of injected bodies and the renderer does NOT truncate at it — every body is injected whatever the total, because a half-rendered hard rule is worse than a warned-but-present one. Char-based, since core has no tokenizer; ~1.5k tokens at 4 chars/tok.
// cm:edge lockstep -> packages/core/src/prompt/facts/resolve.ts — the only reader of this cap, and the one that decides overflow is warned rather than cut
export const ALWAYS_INJECT_MAX_CHARS = 6000;

// cm:guard the one LINE the owner-facing surfaces owe whoever sets this flag, and it is a promise-shaped flag: the tier renders under "Hard rules ... Follow them exactly" and nothing reads the rule back (ISS-936). Interpolate it — never paraphrase — or the surface goes back to implying the control plane enforces the rule.
// cm:guard ONE sentence, and no markdown: it renders as body copy in the settings tab, where the project's own UX contract asks for one calm line, and into an MCP tool description and a terminal-read guide, where backticks would be swallowed. The detail that does not fit a line lives in `ALWAYS_INJECT_ENFORCEMENT_NOTE`.
export const ALWAYS_INJECT_GUARANTEE_NOTE =
  'Flagging a fact always-inject guarantees it is READ, never that it was DONE: the body ' +
  'reaches every agent prompt, and nothing checks whether the agent followed it.';

// cm:guard the rest of the answer, for the surfaces an agent reads rather than the screen: what "nothing checks it" means exactly, and what an obligation with a readback costs. Kept apart from the line above so the settings tab stays one calm line (ISS-936).
// cm:edge contract -> packages/core/src/mcp/tools/forge-config.ts — both notes are appended, in this order, to the end of the tool description
// cm:edge contract -> packages/core/src/guides/registry.ts — both notes are rendered, in this order, into the `project-settings-and-test-credentials` guide
export const ALWAYS_INJECT_ENFORCEMENT_NOTE =
  'No gate refuses a step that ignored an always-inject rule, no step is asked whether it ' +
  'complied, and no surface counts how often one was obeyed; what was injected is visible ' +
  'afterwards on the job, whether it was followed is recorded nowhere. One obligation on this ' +
  'deployment does have a readback, and it shows the price: the UX contract is stored as ' +
  'ux_contract_rules rows with ids, its prose is compiled from them, and agents cite those ids ' +
  'when they record a ux_findings row. A free-text entry has no ids to cite, so write the rule ' +
  'so that an agent following it leaves evidence a human can look at.';
