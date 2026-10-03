/**
 * A questionnaire as plain text: the `content` of its messages, which is what a later model turn
 * reads as history and what a transport with no card shows. The card itself is the block.
 */

import {
  QUESTIONNAIRE_GROUP_LABELS,
  QUESTIONNAIRE_GROUPS,
  type QuestionnaireAnswer,
  type QuestionnaireItem,
} from '@forge/contracts/onboarding';

export function questionnaireText(input: {
  title: string;
  intro?: string | undefined;
  round: number;
  items: readonly QuestionnaireItem[];
}): string {
  const lines = [`${input.title} (round ${input.round})`];
  if (input.intro) lines.push(input.intro);
  let n = 0;
  for (const group of QUESTIONNAIRE_GROUPS) {
    const mine = input.items.filter((i) => i.group === group);
    if (mine.length === 0) continue;
    lines.push('', `${QUESTIONNAIRE_GROUP_LABELS[group]}:`);
    for (const item of mine) {
      n += 1;
      const options = (item.options ?? [])
        .map((o) => `${o.label}${o.id === item.inferredDefault ? ' (inferred)' : ''}`)
        .join(' / ');
      lines.push(
        `${n}. [${item.id}] ${item.prompt}${options ? ` — ${options}` : ''}${item.control === 'accept_reject' ? ' — accept or reject' : ''}`,
      );
    }
  }
  return lines.join('\n');
}

export function answerText(
  item: QuestionnaireItem,
  a: Omit<QuestionnaireAnswer, 'itemId'>,
): string {
  const label = (id: string) => item.options?.find((o) => o.id === id)?.label ?? id;
  if (a.text !== undefined) return `"${a.text}"`;
  if (a.decision) return a.decision === 'accept' ? 'Accepted' : 'Rejected';
  if (a.choices) return a.choices.map(label).join(', ');
  if (a.choice)
    return `${label(a.choice)}${a.choice === item.inferredDefault ? ' (as inferred)' : ''}`;
  return 'Open';
}

export function answersText(input: {
  title: string;
  round: number;
  items: readonly QuestionnaireItem[];
  answers: ReadonlyMap<string, Omit<QuestionnaireAnswer, 'itemId'>>;
}): string {
  const open = input.items.filter((i) => !input.answers.has(i.id)).length;
  const lines = [
    `${input.title} · Round ${input.round} · Answered ${input.answers.size} of ${input.items.length}${open ? ` · Open ${open}` : ''}`,
  ];
  for (const item of input.items) {
    const a = input.answers.get(item.id);
    lines.push(`- [${item.id}] ${item.prompt} → ${a ? answerText(item, a) : 'Open'}`);
  }
  return lines.join('\n');
}
