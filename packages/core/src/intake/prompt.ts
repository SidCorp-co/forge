/**
 * What the intake assistant is told (REQ-34 BC-4, BC-11..BC-16): who it drafts for, the answer shape,
 * and the record it may draw on, each record under the ref a link or a source names it by.
 */

import {
  type ContentLanguageContext,
  type ContentLanguageView,
  contentLanguageBlock,
} from '@forge/contracts/content-language';
import {
  FEEDBACK_KINDS,
  FEEDBACK_ROUTES,
  FEEDBACK_SEVERITIES,
  FEEDBACK_TRIAGE_SHAPE,
} from '@forge/contracts/feedback';
import {
  INTAKE_FIELDS,
  INTAKE_LIMITS,
  INTAKE_QUESTIONS_MAX,
  type IntakeItemKind,
} from '@forge/contracts/intake-drafts';
import type { IntakeItem, IntakeRecord } from './reads.js';

const FIELD_MEANING: Record<IntakeItemKind, Record<string, string>> = {
  requirement: {
    summary: 'one line: what the requirement gives whom',
    goal: 'the problem, the value, and how it is measured',
    persona: 'one person or role it serves, one fill each',
    in_scope: 'one thing it covers, one fill each',
    out_of_scope: 'one thing it leaves out, one fill each',
    criterion: 'one business criterion a person can check, one fill each',
  },
  feedback: {
    kind: `what the item is: ${FEEDBACK_KINDS.join(', ')}`,
    severity: FEEDBACK_SEVERITIES.join(', '),
    requirement: 'the requirement it is about (REQ-n), or none',
    criterion: 'the criterion it says is broken (BC-n of that requirement), or none',
    reproduced: 'whether the record shows it reproduced, and with what evidence, or no',
    route: `where it goes: ${FEEDBACK_ROUTES.join(', ')}`,
  },
};

export function intakeSystemPrompt(
  kind: IntakeItemKind,
  language: ContentLanguageView,
  context: ContentLanguageContext = 'artifact',
): string {
  const fields = INTAKE_FIELDS[kind]
    .map((f) => `  - ${f}: ${FIELD_MEANING[kind][f] ?? f}`)
    .join('\n');
  const what = kind === 'requirement' ? 'requirement was created' : 'feedback item was filed';
  return [
    `A ${what}, written by a person in as little as one sentence. You are the business analyst assistant: you draft the rest so they do not have to. Nobody has to confirm your draft; the author corrects what is wrong.`,
    'Your only input is the item and the product record below: the project’s requirements, workflow designs, feedback and releases. You have not seen the code or the issues; state nothing the record does not hold.',
    '',
    'Answer with one JSON object and nothing else, with these keys:',
    `- "fills": each answer the item leaves open that the record lets you fill, as {"field", "value", "source"}. "source" is the ref of the record it rests on, or the item's own key where its own words say it. Fields:\n${fields}`,
    `- "links": {"relation", "ref", "why", "basis", "itemQuote"} for each record the item duplicates ("duplicate", a record of its own kind), contradicts ("conflict", a requirement), changes ("affected_workflow", a workflow) or shares a problem with ("related_feedback", a feedback item). "ref" is a ref shown below, never the item itself; "why" is one line. Both quotes are copied word for word from what is shown below, at least three words each: "itemQuote" is the item's own words the link rests on; "basis" is the linked record's words: for a conflict, the text of the one criterion the item contradicts (and "why" names no other criterion); for an affected workflow, the step it changes, by its label; for a duplicate or related item, the words it shares with the item. Name no link the record does not show; a link with no such basis is refused.`,
    '- "notAffected": [{"ref", "why"}] for each workflow listed as touched below that the item does not change, with why in one line. Every touched workflow is either linked as "affected_workflow" or named here.',
    `- "questions": at most ${INTAKE_QUESTIONS_MAX}, and only questions whose answer changes the scope or the outcome. Each is {"prompt", "changes": "scope" | "outcome", "options": [${INTAKE_LIMITS.optionsMin}-${INTAKE_LIMITS.optionsMax} of {"id", "label", "effect": what choosing it changes}], "recommended": the id of the option you recommend}. A question the record answers is a fill, not a question.`,
    '- "nothingToAsk": when no question is worth asking, one line saying so, with "questions": []. Otherwise null.',
    kind === 'feedback'
      ? `- "triage": the triage checklist as a triage suggestion takes it: ${FEEDBACK_TRIAGE_SHAPE}. Leave out "dedup"; core adds it. A decline or a duplicate rests only on a link above: a decline's note names no record that no link names.`
      : '- Leave out "triage".',
    '',
    contentLanguageBlock(language, context),
  ].join('\n');
}

export function intakeUserMessage(
  item: IntakeItem,
  record: {
    requirements: IntakeRecord[];
    workflows: IntakeRecord[];
    feedback: IntakeRecord[];
    releases: IntakeRecord[];
  },
  touched: readonly string[] = [],
): string {
  const section = (title: string, rows: IntakeRecord[]) => [
    `${title}:`,
    ...(rows.length ? rows.flatMap((r) => r.lines) : ['  (none)']),
  ];
  return [
    `The ${item.kind} ${item.key}:`,
    ...item.lines.map((l) => `  ${l}`),
    '',
    ...section('Requirements', record.requirements),
    '',
    ...section('Workflow designs', record.workflows),
    '',
    ...section('Feedback', record.feedback),
    '',
    ...section('Releases', record.releases),
    '',
    `Workflows the item's words touch (link each as affected_workflow, or name it in notAffected): ${touched.length ? touched.join(', ') : '(none)'}`,
  ].join('\n');
}
