// Who owes a decision (REQ-79 BC-13, BC-14; owner ruling 2026-10-31): agents decide by default and
// record what they decided. A person is asked only on a project that asked for control (`strict`),
// and there only for a decision its asker judged serious: irreversible, real money, credentials or
// product direction. Every other decision is the project's master's or agent's. The ask doors, the
// questions core asks, the answer door and the void door all read it here.

import type { QuestionRefusalCode } from '@forge/contracts/questions';
import type { QuestionBlockerKind } from '../db/schema-questions.js';
import { refuser } from '../lib/refusal.js';
import { readGateProfile } from '../project-config/index.js';

/**
 * Why an agent may decide a question on `projectId` itself, or null where it is a person's: the
 * project is strict and the question serious.
 */
export async function agentDecidesWhy(projectId: string, serious: boolean): Promise<string | null> {
  const profile = await readGateProfile(projectId);
  if (profile === 'strict') {
    return serious
      ? null
      : 'this project is strict (gates.profile), and the question is not marked serious';
  }
  return `this project's gate profile is ${profile}, not strict (gates.profile)`;
}

/** The blocker a decision asked of a person is owed by: the person where it is theirs, else the master. */
export async function decisionOwedBy(
  projectId: string,
  serious: boolean,
): Promise<'human' | 'master_or_peer'> {
  return (await agentDecidesWhy(projectId, serious)) === null ? 'human' : 'master_or_peer';
}

/** What makes a decision serious, as a refusal names it. */
export const SERIOUS = 'irreversible, real money, credentials or product direction';

const refuse = refuser<QuestionRefusalCode>('QUESTION_REFUSED');

/**
 * Who a question asked of a person is owed by: an agent asking a person what it may decide itself
 * is refused by name; a decision core asks (`decides`) is the person's only where the project is
 * strict and it is serious, the master's otherwise. Every other ask is owed by the blocker it names.
 */
export async function owedBlockerOf(input: {
  projectId: string;
  blockerKind: QuestionBlockerKind;
  serious?: boolean | undefined;
  decides?: true | undefined;
  askedByRun?: true | undefined;
  askedByAgent?: true | undefined;
}): Promise<QuestionBlockerKind> {
  if (input.blockerKind !== 'human') return input.blockerKind;
  const serious = input.serious === true;
  if (input.decides) return decisionOwedBy(input.projectId, serious);
  if (!input.askedByRun && !input.askedByAgent) return 'human';
  const why = await agentDecidesWhy(input.projectId, serious);
  if (why === null) return 'human';
  throw refuse(
    'QUESTION_AGENT_DECIDES',
    `an agent asks a person only for a decision it judged serious (${SERIOUS}), and only on a project that asked for control: ${why}. Decide it and record the decision on the item it shapes, or ask the project's master with \`blockerKind: "master_or_peer"\`; on a strict project, a serious one is asked with \`serious: true\``,
    '/blockerKind',
  );
}
