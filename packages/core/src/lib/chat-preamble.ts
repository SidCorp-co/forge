import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';

const BRANCH_SENTINEL = '<detect-from-git>';

/**
 * Tool reference block shared with the desktop runner. Trimmed from the
 * Strapi-era TOOL_REFERENCE — kept entries that map to MCP tools currently
 * shipping in core (`forge_issues`, `forge_comments`, `forge_memory`,
 * `forge_config`, `forge_skills`). Antigravity / Coolify / Cloudflare entries
 * removed since those subsystems are not on core today.
 */
export const TOOL_REFERENCE = `## Tool Reference
- **forge_issues** — list/get/create/update/transition issues + sub-tasks (createTask/listTasks/updateTask/deleteTask). update.documentId is required. Writable: title, description, status, priority, category, complexity, acceptanceCriteria, plan, sessionContext, relations. Use transition (not update) for status changes so the state machine validates the move.
- **forge_comments** — list/create/delete comments. create requires issueDocumentId + body; supports base64 attachments. list returns actor, body, isAI, parentId, timestamps.
- **forge_memory** — search/sync project + global memory. Strategies: semantic, keyword, graph, hybrid (default), auto. Always search first (limit 3); skip the add when an existing memory scores > 0.8.
- **forge_config** — read/write per-project settings: repoPath, baseBranch, productionBranch, branchConfig override per-issue, categories, pipelineConfig. Pass issueId to get the resolved branchConfig layered on top of the project default.
- **forge_skills** — list available skills + per-project enable/disable registrations.
- **forge_projects** — list projects visible to the device principal (slug, name, role).`;

function formatProjectConfig(
  baseBranch: string | null,
  productionBranch: string | null,
): string {
  const b = baseBranch ?? BRANCH_SENTINEL;
  const p = productionBranch ?? BRANCH_SENTINEL;
  let out = `## Project Config\n- stagingBranch: ${b}\n- productionBranch: ${p}`;
  if (!baseBranch || !productionBranch) {
    out += `\n\nBranch detection: any value shown as \`${BRANCH_SENTINEL}\` is not configured. Before any git operation, run \`git symbolic-ref refs/remotes/origin/HEAD | sed 's@^refs/remotes/origin/@@'\` and use the result instead. If detection fails, abort and ask the user via \`forge_config\`.`;
  }
  return out;
}

/**
 * Pipeline rules shared with every pipeline job. Kept stable so the Claude
 * prompt cache (5 min TTL) hits across consecutive pipeline jobs in the same
 * project. Any change here invalidates the cache for ALL projects until the
 * next 5-minute window.
 */
export const PIPELINE_RULES = `## Pipeline Rules
- **Status LAST.** Set the issue status as the FINAL action of your turn — it is what fires the next pipeline step. If you transition early, downstream skills may run against a half-written plan, commit, or session context.
- **Branch discipline.** Run \`git branch --show-current\` and \`git status\` before any checkout. Branch from the resolved \`baseBranch\` (see Project Config below): \`git checkout <baseBranch> && git pull && git checkout -b ISS-<NN>-short-title\`. Never switch branches mid-work and never rebase across pipeline steps.
- **ISS-* branch is the source of truth.** Kept alive end-to-end through the pipeline. Squash-merges to \`productionBranch\` at release. Do not delete the branch until the release skill has finished.
- **Fetch issue first.** Never assume issue data from the prompt — always call \`forge_issues.get\` and read the latest \`description\`, \`acceptanceCriteria\`, \`plan\`, \`sessionContext\` before acting.
- **English only.** All code, identifiers, comments, log lines, UI strings, commit messages, branch names, and PR titles MUST be in English regardless of the language the issue is written in. If the plan or description contains non-English UI strings, translate to natural English before implementing — never copy verbatim into JSX, toasts, or test assertions.
- **Worktrees on a busy main.** If \`git status -s\` is dirty or \`git worktree list\` shows more than one entry, work in \`.claude/worktrees/iss-<NN>-short-title/\` so parallel sessions stay isolated. All subsequent git commands run inside the worktree.
- **Conventional commits with package scope.** \`feat(core):\`, \`fix(web):\`, \`refactor(dev):\`, etc. Body MUST include \`Resolves ISS-<NN>\` so the pipeline can correlate commits back to the issue.

## Capture Learnings
When you hit a non-obvious pattern, convention violation, or fix worth teaching future agents:
1. Search \`forge_memory\` first (keyword strategy, scoped to the current skill, limit 3).
2. If no existing memory scores > 0.8, add one via \`forge_memory\` (role appropriate to the skill, category \`correction\` or \`convention\`).
Filter: would this help a DIFFERENT agent on a DIFFERENT issue tomorrow? If not, skip — keep memory signal high.

## Session Context (code / fix / review tasks)
Before your final status transition, update the issue's \`sessionContext\` via \`forge_issues.update\`:
\`{ currentState, decisions, filesModified, errorsResolved, reviewFeedback, sessionCount, lastUpdated }\`
Merge with the existing value — increment \`sessionCount\`, append to arrays (skip duplicate strings), replace \`currentState\` with the latest summary. Cap each array at 20 entries; drop the oldest when full.

## Output Rules
- Zero narration. Tool calls are self-documenting; the harness logs everything.
- Code only while implementing — no explanations between edits.
- Never repeat file contents after reading; go straight to the edit.
- One-line status at the end (e.g. \"Plan written, set approved.\" or \"Fix applied, pushed, set developed.\").
- User-visible commentary goes to \`forge_comments\`, NOT to chat output. The chat output is for the operator tailing the runner log, not the issue audience.
`;

/**
 * Lightweight chat preamble for non-pipeline conversations started from web.
 * Strapi parity used `knowledgeIndex` + `conventions` columns that do not
 * exist in core's `projects` schema — we ship the project config block only
 * and let the agent fetch knowledge via `forge_config` if needed.
 */
export async function buildChatPreamble(projectId: string): Promise<string> {
  const [project] = await db
    .select({
      baseBranch: projects.baseBranch,
      productionBranch: projects.productionBranch,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) return '';
  return `${formatProjectConfig(project.baseBranch, project.productionBranch)}\n\n---\n\n`;
}

/**
 * Pipeline preamble — stable cacheable prefix for pipeline jobs. Combines
 * `PIPELINE_RULES` + `TOOL_REFERENCE` + per-project branch config. The
 * dispatcher passes the result to the desktop runner on `job.assigned`; the
 * runner forwards it to the Claude CLI as `--append-system-prompt` so the
 * Anthropic prompt cache (5 min TTL) hits across consecutive jobs in the
 * same project.
 *
 * When the project row is missing (should not happen at dispatch time —
 * `loadRepoPath` would have already failed), the function still returns the
 * static rules + tools block rather than throwing; the resulting preamble
 * just lacks the project-specific branch lines.
 */
export async function buildPipelinePreamble(projectId: string): Promise<string> {
  const [project] = await db
    .select({
      baseBranch: projects.baseBranch,
      productionBranch: projects.productionBranch,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const baseBranch = project?.baseBranch ?? null;
  const productionBranch = project?.productionBranch ?? null;
  return `${PIPELINE_RULES}\n${TOOL_REFERENCE}\n\n${formatProjectConfig(baseBranch, productionBranch)}\n\n---\n\n`;
}
