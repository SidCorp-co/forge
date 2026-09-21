import { CONTRACT_SOURCE, type ContractAnswer } from './contract-answer.js';

/** The one name this check is published under, on every head, forever. */
export const CHECK_RUN_NAME = 'forge/issue-contract';

export type CheckConclusion = 'success' | 'failure' | 'neutral';

export interface CheckRunBody {
  name: string;
  conclusion: CheckConclusion;
  title: string;
  summary: string;
  text: string;
}

const LAPSE_NOTE =
  'This answer is as of the time above. Every input to it is re-read on an event — a new head, a ' +
  'status move, a record written, a dependency edge changed — except one: a `blocks` work-evidence ' +
  'waiver stops counting when its `validUntil` passes, and nothing is written when that happens. ' +
  'Forge does not poll, so a waiver that lapsed after the time above is still counted here.';

const stamp = (at: Date) => `Answered at ${at.toISOString()}.`;

function judged(answer: Extract<ContractAnswer, { kind: 'judged' }>): CheckRunBody {
  const { status, met, unmet } = answer;
  const lines = [
    `Contract read: ${CONTRACT_SOURCE}.`,
    '',
    `Status: \`${status}\`, which declares ${answer.declared.length} record(s).`,
    '',
  ];
  lines.push(
    met.length > 0 ? '### On this issue' : '### On this issue\n\nNothing declared is met.',
  );
  for (const key of met) lines.push(`- \`${key}\``);
  lines.push('', '### Missing');
  if (unmet.length === 0) lines.push('Nothing.');
  for (const { key, detail } of unmet) lines.push(`- \`${key}\` — ${detail}`);
  lines.push('', stamp(answer.computedAt), '', LAPSE_NOTE);

  return {
    name: CHECK_RUN_NAME,
    conclusion: unmet.length === 0 ? 'success' : 'failure',
    title:
      unmet.length === 0
        ? `\`${status}\` is earned: ${met.length} of ${met.length} record(s) present`
        : `\`${status}\` is not earned: ${unmet.length} of ${answer.declared.length} record(s) missing`,
    summary:
      unmet.length === 0
        ? `Every record \`${status}\` declares is on this issue.`
        : `${unmet.length} record(s) \`${status}\` declares are not on this issue.`,
    text: lines.join('\n'),
  };
}

function noneDeclared(answer: Extract<ContractAnswer, { kind: 'none-declared' }>): CheckRunBody {
  return {
    name: CHECK_RUN_NAME,
    conclusion: 'neutral',
    title: `\`${answer.status}\` declares no entry criteria on this project`,
    summary:
      `This project declares no records for \`${answer.status}\`, so there is nothing here for ` +
      'Forge to hold this issue to. That is a project setting and not a pass.',
    text: [
      `Contract read: ${CONTRACT_SOURCE}.`,
      '',
      `Nothing is declared for \`${answer.status}\`, so nothing was judged. This is not the same ` +
        'as every record being present, and it is not the same as the contract being unreadable ' +
        '— each of the three says so in its own words.',
      '',
      'Declare what a status requires under `pipelineConfig.statusEntryCriteria`.',
      '',
      stamp(answer.computedAt),
    ].join('\n'),
  };
}

function unreadable(answer: Extract<ContractAnswer, { kind: 'unreadable' }>): CheckRunBody {
  const where = answer.status ? `\`${answer.status}\`` : 'an unknown status';
  return {
    name: CHECK_RUN_NAME,
    conclusion: 'neutral',
    title: 'The contract could not be read for this issue',
    summary:
      `Forge could not work out what ${where} requires here, so it is reporting that rather than ` +
      'a verdict it did not earn.',
    text: [
      `Contract read: ${CONTRACT_SOURCE}.`,
      '',
      `What went wrong: ${answer.reason}`,
      '',
      'This is NOT a pass and NOT a project that declares nothing. It is Forge saying it could ' +
        'not find out, which is the one answer it owes you when it cannot.',
      '',
      stamp(answer.computedAt),
    ].join('\n'),
  };
}

export function checkRunBody(answer: ContractAnswer): CheckRunBody {
  switch (answer.kind) {
    case 'judged':
      return judged(answer);
    case 'none-declared':
      return noneDeclared(answer);
    case 'unreadable':
      return unreadable(answer);
  }
}
