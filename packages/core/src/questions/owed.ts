// Who owes a decision (REQ-79 BC-13, BC-14; owner ruling 2026-10-31): agents decide by default and
// record what they decided. A person is asked only on a project that asked for control (`strict`),
// and there only for a decision its asker judged serious: irreversible, real money, credentials or
// product direction; or where the project's own rule names that person's act (ISS-869): a project
// that wrote a rule asking for its owner keeps it, whatever its gate profile. Every other decision is
// the project's master's or agent's. The ask doors, the questions core asks, the answer door and the
// void door all read it here; what makes an act serious is the one table's (`@forge/contracts/who-owes`).

import type { QuestionRefusalCode } from '@forge/contracts/questions';
import { SERIOUS } from '@forge/contracts/who-owes';
import type { QuestionBlockerKind } from '../db/schema-questions.js';
import { readProjectRule } from '../knowledge/index.js';
import { refuser } from '../lib/refusal.js';
import { readGateProfile } from '../project-config/index.js';

/** What makes a question a person's, as its row carries it: serious, and the rule it names. */
export interface Owing {
  serious: boolean;
  /** The slug of the project rule naming a person's act that this question asks for (ISS-869). */
  rule?: string | null | undefined;
}

/**
 * Why an agent may decide a question on `projectId` itself, or null where it is a person's: it names
 * a rule of the project asking for that person's act, or the project is strict and the question
 * serious. A stored rule was checked when the question was asked (`owedBlockerOf`).
 */
export async function agentDecidesWhy(projectId: string, owing: Owing): Promise<string | null> {
  if (owing.rule) return null;
  const profile = await readGateProfile(projectId);
  if (profile === 'strict') {
    return owing.serious
      ? null
      : 'this project is strict (gates.profile), and the question is not marked serious';
  }
  return `this project's gate profile is ${profile}, not strict (gates.profile), and the question names no rule of the project asking for a person's act`;
}

/** Why a question is a person's, as a refusal of an agent's answer or void says it. */
export function personsBecause(owing: Owing): string {
  return owing.rule
    ? `this question names the project rule \`${owing.rule}\`, which asks a person's act`
    : `this question is marked serious (${SERIOUS}) on a strict project`;
}

/** The blocker a decision asked of a person is owed by: the person where it is theirs, else the master. */
export async function decisionOwedBy(
  projectId: string,
  serious: boolean,
): Promise<'human' | 'master_or_peer'> {
  return (await agentDecidesWhy(projectId, { serious })) === null ? 'human' : 'master_or_peer';
}

/** What makes a decision serious, as a refusal names it: the one rule's classes (`@forge/contracts/who-owes`). */
export { SERIOUS };

const refuse = refuser<QuestionRefusalCode>('QUESTION_REFUSED');

/**
 * The rule a question names, checked: a live rule of this project, and named on a question asked of a
 * person, since a rule admits a person's act and nothing else. Wrong input is refused by name.
 */
async function checkRule(
  projectId: string,
  rule: string,
  blockerKind: QuestionBlockerKind,
): Promise<void> {
  if (blockerKind !== 'human') {
    throw refuse(
      'QUESTION_SHAPE_INVALID',
      `\`rule\` names the project rule that asks a person's act, and this question is asked of \`${blockerKind}\`, not of a person: drop \`rule\`, or ask it with \`blockerKind: "human"\``,
      '/rule',
    );
  }
  const read = await readProjectRule(projectId, rule);
  if (!read.ok) {
    throw refuse(
      'QUESTION_RULE_UNKNOWN',
      `\`rule\` ${JSON.stringify(rule)} names no rule of this project: ${read.why}. Name the slug of the project's own rule that asks for the person's act (\`GET /api/projects/${projectId}/knowledge\` lists them)`,
      '/rule',
    );
  }
}

/**
 * Who a question asked of a person is owed by: an agent asking a person what it may decide itself
 * is refused by name; a decision core asks (`decides`) is the person's only where the project is
 * strict and it is serious, the master's otherwise. A question naming a rule of the project that asks
 * a person's act is that person's on any project. Every other ask is owed by the blocker it names.
 */
export async function owedBlockerOf(input: {
  projectId: string;
  blockerKind: QuestionBlockerKind;
  serious?: boolean | undefined;
  rule?: string | undefined;
  decides?: true | undefined;
  askedByRun?: true | undefined;
  askedByAgent?: true | undefined;
}): Promise<QuestionBlockerKind> {
  if (input.rule !== undefined) await checkRule(input.projectId, input.rule, input.blockerKind);
  if (input.blockerKind !== 'human') return input.blockerKind;
  const serious = input.serious === true;
  if (input.decides) return decisionOwedBy(input.projectId, serious);
  if (!input.askedByRun && !input.askedByAgent) return 'human';
  const why = await agentDecidesWhy(input.projectId, { serious, rule: input.rule });
  if (why === null) return 'human';
  throw refuse(
    'QUESTION_AGENT_DECIDES',
    `an agent asks a person only for a decision it judged serious (${SERIOUS}) on a project that asked for control, or for an act the project's own rule names as that person's: ${why}. Decide it and record the decision on the item it shapes, or ask the project's master with \`blockerKind: "master_or_peer"\`; on a strict project, a serious one is asked with \`serious: true\`; where a rule of this project asks for the person's act, name it with \`rule: "<its knowledge slug>"\``,
    '/blockerKind',
  );
}
