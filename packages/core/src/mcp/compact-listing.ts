import type { Tool } from '@modelcontextprotocol/server';

/**
 * `tools/list` for ChatGPT: the same tools, each with a short summary and an input stripped of what
 * the model does not need to call it right. ChatGPT's connector lists the full 56 KB catalog and
 * reports "action discovery failed" (ISS-768 r2); its documented limit is the whole catalog under
 * about 5,000 tokens. A call is still judged by the tool's full published schema (`input-gate.ts`),
 * so what the compact listing leaves out never widens what the server accepts.
 */

/** The budget a compact `tools/list` answer's tools fit in, serialized. */
export const COMPACT_BUDGET_BYTES = 16 * 1024;
/** The longest a property description is kept; a longer one is dropped. */
const PROPERTY_DESCRIPTION_MAX = 80;
/** Keywords the model calls correctly without, and the server judges from the full schema. */
const NOISE = new Set(['pattern', 'format', 'maxLength', 'minLength', 'maxItems', 'minItems']);

/** The tools a business analyst works with in ChatGPT, kept first when the catalog must shrink. */
const BA_TOOLS = [
  'forge_requirements',
  'project_feedback',
  'forge_questions',
  'forge_feedback',
  'forge_design',
  'forge_releases',
  'forge_issues',
] as const;

/** A summary per tool: what it does and its actions, at most 400 characters. */
export const COMPACT_DESCRIPTIONS: Record<string, string> = {
  forge_requirements:
    "A project's requirements (REQ-n): read, draft, revise and track delivery. Reads: list, get, progress (runs, waits, ETA), similar. Writes: create, revise (pass baseRevision), propose, withdraw, answer (a clarifying question). Answers carry progress: running, waitingOn, work and eta.",
  project_feedback:
    "A project's own feedback (FB-n) about its product: read it, file it, ask its reporter, follow the work it became. Reads: list, get, progress, similar. Writes: submit (kind, title, body), clarify (ask the reporter). Feedback about Forge itself is forge_feedback.",
  forge_questions:
    'Questions waiting on a person. list { projectId, status?, issue? } what is owed an answer; get one; answer { questionId, round, optionId or text }; ask { issue, body } a question on an issue.',
  forge_feedback:
    "Feedback about Forge itself (CLI, routes, tools, guides, web app, pipeline), filed into Forge's home project as you. submit { kind, title, target, body? }; list; get; progress; verify; reopen; reply.",
  forge_design:
    'Product design records: workflow designs, suggestions and mockups. Reads: design_list, design_get, suggestion_list, mockup_list, mockup_get, mockup_comments. Writes: design_create/revise/propose/decide/withdraw, suggestion_create/accept/reject/revise/withdraw, mockup_propose/accept/return/withdraw/comment. Decide only what the person asked.',
  forge_releases:
    "A project's releases: what shipped, what is drafted, what waits on approval. list { projectId, state?, limit? }; get { version }; page { version, view? }; name { version, name, summary }; decide { version, decision, reason? } approve or return.",
  forge_issues:
    "Delivery work as a person follows it: each issue's status, whether an agent works on it now, and its forecast. list { projectId, status?, search?, limit? }; get { issue }; create { title, ... } files one.",
  forge_uploads:
    'Read an issue, comment or session attachment: fetch { data: { target: issue|comment|session, attachmentId } }. Images come back as an image block.',
  forge_channel:
    "Act in a project's ecosystem channel. Reads: register, inbox, outbox, unanswered, read, thread, contracts. Writes: draft, reply, edit, submit, hold, release, withdraw, supersede, gate.",
  forge_ecosystem:
    "A project's ecosystem records: interface, links to contracts it consumes, builder runs, bus. Reads: interface, links, link, builder_runs, builder_run, context, bus. Writes: interface_write, link_create/update, builder_run_create/update/supersede, contract_version_publish/decide.",
  forge_support:
    'Answer a support group or operations room as its assistant: search, thread, tools, reply, run, propose_fix, record, move_issue, build, deploy, command, channel, member, rule, common_issue, route, announce, projects, issues, releases, move, draft_requirement, draft_feedback, research.',
};

type Schema = Record<string, unknown>;
const isPlain = (v: unknown): v is Schema =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** `schema` without noise keywords, its long property descriptions dropped, its short ones kept. */
function compactSchema(schema: unknown, root = true): unknown {
  if (Array.isArray(schema)) return schema.map((s) => compactSchema(s, false));
  if (!isPlain(schema)) return schema;
  const out: Schema = {};
  for (const [k, v] of Object.entries(schema)) {
    if (NOISE.has(k)) continue;
    if (k === 'description') {
      if (!root && typeof v === 'string' && v.length <= PROPERTY_DESCRIPTION_MAX) out[k] = v;
      continue;
    }
    if (k === 'properties' && isPlain(v)) {
      out[k] = Object.fromEntries(Object.entries(v).map(([n, s]) => [n, compactSchema(s, false)]));
      continue;
    }
    if (k === 'enum' || k === 'required' || k === 'default') {
      out[k] = v;
      continue;
    }
    out[k] = compactSchema(v, false);
  }
  return out;
}

const bytesOf = (tools: unknown[]) => Buffer.byteLength(JSON.stringify({ tools }));

/**
 * The compact form of the full listing `tools` (`toolListing`): every tool where the whole fits the
 * budget, else the BA set alone. A BA set that still does not fit is refused by name, never cut
 * further in silence.
 */
export function compactListing(tools: Tool[]): Tool[] {
  const compact = (list: Tool[]) =>
    list.map((t) => {
      const description = COMPACT_DESCRIPTIONS[t.name];
      if (!description) {
        throw new Error(
          `mcp registry: ${t.name} has no compact summary, so ChatGPT's listing cannot carry it; write one in COMPACT_DESCRIPTIONS (mcp/compact-listing.ts)`,
        );
      }
      return {
        name: t.name,
        description,
        inputSchema: compactSchema(t.inputSchema) as Tool['inputSchema'],
      };
    });
  const all = compact(tools);
  if (bytesOf(all) <= COMPACT_BUDGET_BYTES) return all;
  const ba = compact(tools.filter((t) => (BA_TOOLS as readonly string[]).includes(t.name)));
  if (bytesOf(ba) > COMPACT_BUDGET_BYTES) {
    throw new Error(
      `mcp registry: ChatGPT's compact listing of the BA tools is ${bytesOf(ba)} bytes, over its ${COMPACT_BUDGET_BYTES}; shorten their inputs or summaries (mcp/compact-listing.ts)`,
    );
  }
  return ba;
}
