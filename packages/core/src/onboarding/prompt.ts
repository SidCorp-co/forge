/**
 * The whole method of an onboarding job, carried in its prompt (workflow project-onboarding rev 1,
 * tasks `analyse`, `draft`, `ask` and `revise`). The runner never branches on a job's type, so
 * this text is the only place the method lives; it carries what the two hand-run trials found
 * (~/forge-local-docs/onboarding-trial-autoflow.md, onboarding-trial-hop.md).
 */

import { QUESTIONNAIRE_MAX_ITEMS, QUESTIONNAIRE_MAX_ROUNDS } from '@forge/contracts/onboarding';

export interface OnboardingPromptContext {
  projectId: string;
  projectName: string;
  onboardingId: string;
  conversationId: string;
  /** The project's data policy holds personal or health data: the data flow is mandatory. */
  sensitiveData: boolean;
  /** The repository the project document declares; with none, Forge records are the evidence. */
  repository: string | null;
  /** The branch work lands on (`source.git.defaultBranch`): the tree the analysis reads. */
  defaultBranch: string | null;
  roundsSent: number;
  reason?: string | null;
}

const TOOLS = `Tools (Forge MCP; every write is refused by name with what is valid — read the refusal and fix, never work around it):
- forge_onboarding: { action: post_questionnaire | read_answers | post_update | mark_done, projectId }.
- forge_workflows: templates / template (read a template's node types and required fields first), write (create: no workflowId, baseRevision null), propose { workflowId, revision }.
- forge_knowledge: upsert { projectId, slug, title, body, kind: reference, injection: on_demand, authoredBy: agent, confidence: inferred }.`;

const FINDINGS = `What the hand-run trials found — follow it:
1. A design you create lands at DRAFT. It reaches proposed only through forge_workflows propose { workflowId, revision }. Create, then propose, every design. Never approve: the user decides the picture you drew of their code.
2. Write system-context FIRST: the integration sequence, the data flow and the journey reference its SYSTEM and CONTAINER steps, and a ref to a design that does not exist yet is WORKFLOW_REF_DANGLING.
3. ux-flow needs a wireframe on every SCREEN, and onboarding has none: draw the core business journey in operational-flow (or service-blueprint), not ux-flow.
4. In system-context, a line into a SYSTEM needs an explicit kind (uses / reads-from / writes-to), or it is WORKFLOW_EDGE_KIND_AMBIGUOUS. Lines go forward only (after): a two-way integration is one line whose label says both ways.
5. A design holds the plan only, never a step status or evidence. A project with no code cites Forge records (requirement criteria REQ-n BC-n, design steps, issue comments, knowledge slugs) in the questionnaire item's evidence, never a guessed file:symbol.
6. What the code already holds is an observation, written apart from the design (POST /api/projects/:id/workflows/:workflow/observations), each observed step citing the file:symbol that writes it and naming the planned step it matches. An enum value or a status with no writer, or no reader, is not in the code: leave it out of the observation and ask about it. Grep for the writer and the reader of every status before drawing a state.
7. The central entity is rarely named: pick the one most modules reference, say why with the counts, and ask (a question with the inferred default) when two compete.
8. \`does\` is at most 600 characters, a label 60, a summary 400. At most 40 steps per design.
9. Draw the product's own runtime: its users, its parts, the systems it talks to. Never draw Forge, its agents, its LLM, or the development pipeline as part of the product. A project policy such as sensitive-data handling is a Forge project setting. If it is also a product rule, write it as a requirement or a design note, never as a node.
10. A summary states what the design shows, not how it was drawn: no "drawn from Forge records", "no source code", "read from the code at <sha>" or "revision N translates revision M".`;

const CODE_MAP = `The code map (knowledge entries, one per section, kebab-case slug onboarding-code-map-<section> (a knowledge slug carries no slash), each fact with its file:symbol):
1. Entry points: each binary or app, what it does, the env keys it needs (names only, never values).
2. Routes by gate: public, authenticated, internal (shared secret), host-routed.
3. Tables by module, and the central entity with the evidence for choosing it.
4. Every status enum with its writer and its reader — a value missing either is a question.
5. Jobs and listeners: crons, workers, the event bus, their locking.
6. External systems: protocol, credential env key, owner (or an open question).
7. Personal data and credentials: where each is stored, hashed or encrypted, where it leaves.
8. Docs that disagree with the code, each as a pair of anchors.
9. Competing implementations and dead code.`;

function questionnaireRules(roundsSent: number) {
  return `The questionnaire (forge_onboarding post_questionnaire { title, intro?, items }):
- One batch, at most ${QUESTIONNAIRE_MAX_ITEMS} items, grouped question / clarification / recommendation. This is round ${roundsSent + 1} of at most ${QUESTIONNAIRE_MAX_ROUNDS}.
- Each item: id (stable, e.g. q-central-entity), group, control (choice | multi | text | accept_reject — a recommendation is always accept_reject), prompt (in the language the project's people write in), options with ids for choice and multi, inferredDefault (the option the code suggests: it is marked, never chosen for them), why (one or two sentences), evidence (file:symbol, or a record citation), affects (the workflow ids it shapes).
- Ask only what the code and the records cannot settle. Prefer a choice with an inferred default over an open text.
- An accepted recommendation becomes a suggestion or a proposed design revision, never current: say so in its why.`;
}

// cm:why the pane opens in the device binding's checkout as it stands, which can lag its remote by
// hundreds of commits; designs drawn from it describe a product that no longer exists
function landedTree(branch: string | null, onboardingId: string) {
  const ref = branch ? `origin/${branch}` : "the remote's default branch (git remote show origin)";
  return `the tree at ${ref}, never the checkout as it stands: the checkout you start in can lag its remote. Run git fetch origin, then git worktree add --detach .claude/worktrees/onboarding-${onboardingId} ${branch ? ref : '<that branch>'}, read and cite file:symbol from that worktree, name its sha in your first update, and remove it when you stop. Never commit, switch or reset the checkout you start in`;
}

export function analysePrompt(ctx: OnboardingPromptContext): string {
  return [
    `You are onboarding project "${ctx.projectName}" (${ctx.projectId}) into Forge: onboarding ${ctx.onboardingId}, its thread is conversation ${ctx.conversationId}. This is the ONE analysis job of this onboarding${ctx.reason ? `, a re-analysis a person asked for: ${ctx.reason}` : ''}. Onboarding never blocks the project; do not touch its issues.`,
    TOOLS,
    `Do, in order, then stop:
1. Analyse ${ctx.repository ? `${landedTree(ctx.defaultBranch, ctx.onboardingId)} (stack, entry points, routes, data models, integrations, docs, personal-data signals)` : 'the project through Forge — it names no repository: its config, policy, knowledge, workflows, requirements and their criteria, issues and comments'}. Read before you write.
2. Write the code map as knowledge entries (below).
3. Draft the key designs as-built and propose each: system context, the core business journey, the central entity state machine — always; an integration sequence when the code calls an outside system (webhook, API client, queue); a data flow ${ctx.sensitiveData ? "— MANDATORY: this project holds sensitive data (its data policy is on), so draw the product's own trust boundaries and where the product redacts; mark_done is refused ONBOARDING_DATA_FLOW_MISSING without it" : "when the code holds personal or health data (mandatory then, with the product's own trust boundaries and where the product redacts)"}. A design of a flow that already exists gets a new revision, never a second design.
4. forge_onboarding post_update { text, designs: { heading: "Designs drafted", workflowIds } }: a short summary of what you read (stack, modules, routes, models, integrations with counts) — this registers the designs with the onboarding.
5. forge_onboarding post_questionnaire with everything you could not settle.
6. Stop. The person answers in the chat; a new job reads the answers.`,
    FINDINGS,
    CODE_MAP,
    questionnaireRules(ctx.roundsSent),
  ].join('\n\n');
}

export function revisePrompt(ctx: OnboardingPromptContext & { batchId: string }): string {
  return [
    `Onboarding ${ctx.onboardingId} of project "${ctx.projectName}" (${ctx.projectId}): the person answered questionnaire ${ctx.batchId} in conversation ${ctx.conversationId}. Turn the answers into revisions, then stop.`,
    TOOLS,
    `Do, in order, then stop:
1. forge_onboarding read_answers: each item with its state (answered / open / void) and the answer.${ctx.repository ? ` Any code you read is ${landedTree(ctx.defaultBranch, ctx.onboardingId)}.` : ''}
2. For each answered question or clarification, write a new revision of the design it affects that cites the item (in the step's does or the revision reason) and propose it. An accepted recommendation becomes a proposed design revision or a suggestion (forge_suggestions create) — never current. A rejected one is recorded: do not suggest it again (a repeat is refused QUESTIONNAIRE_RECOMMENDATION_REJECTED).
3. forge_onboarding post_update { text, designs: { heading: "Updated designs", workflowIds } } naming what changed.
4. Then exactly one of:
   - items stayed open (or the answers raised new questions) and fewer than ${QUESTIONNAIRE_MAX_ROUNDS} rounds were sent: post_questionnaire with ONLY the open items (same ids) and the new ones (isNew: true);
   - otherwise: post_update { text, designs: { heading: "Designs ready for your approval", workflowIds: every onboarding design, approve: true } }, list what stays open on its design as an open question, then mark_done.`,
    FINDINGS,
    questionnaireRules(ctx.roundsSent),
  ].join('\n\n');
}
