// The assistant's draft of a release's name and summary (REQ-40 BC-14): one call through the gateway
// (`completeOnce`, so the deployment's provider and the project's data policy apply as they do to a
// chat turn), shown the issues the release carries and nothing else: each one's note, or its own
// criteria where it has none. No requirement is shown, so a release carrying one of its criteria is
// never named for the rest. The answer is judged by `judgeNaming`; a refused answer gets one retry
// carrying the refusal, then the draft is `refused` with what it was refused for. The pattern is
// `draft.ts:draftHighlights`.

import { contentLanguageBlock } from '@forge/contracts/content-language';
import type { Refusal } from '@forge/contracts/refusal';
import {
  judgeNaming,
  namingForOperatorsOnly,
  type ReleaseNamingFacts,
  usersUnchangedSentence,
} from '@forge/contracts/release-naming';
import {
  RELEASE_NAME_WORDS_MAX,
  RELEASE_SUMMARY_SENTENCES,
  type ReleaseNaming,
  ReleaseNamingSchema,
} from '@forge/contracts/release-notes';
import type { ReleaseDetail } from '@forge/contracts/releases';
import {
  type ChatMessage,
  type ChatStreamUsage,
  type CompletionAnswer,
  completeOnce,
} from '../integrations/llm/index.js';
import { logger } from '../lib/logger.js';
import { readContentLanguage } from '../project-config/index.js';
import { recordSpend } from './draft.js';

/** A hung provider cannot hold a naming draft longer than this per call. */
const CALL_TIMEOUT_MS = 60_000;

export type NamingOutcome =
  | { kind: 'drafted'; naming: ReleaseNaming; model: string }
  | { kind: 'refused'; refusals: Refusal[]; model: string | null }
  | { kind: 'missed'; refusal: Refusal; model: string | null };

/**
 * What the namer reads of a release: each issue it carries, by the note that issue was given, and by
 * its own criteria (`unnotedCriteria`, keyed by issue key) where it was given none.
 */
export function namingFacts(
  detail: ReleaseDetail,
  unnotedCriteria: ReadonlyMap<string, readonly string[]>,
): ReleaseNamingFacts {
  const facts: ReleaseNamingFacts = {
    version: detail.version,
    changes: detail.notes.sections
      .filter((s) => s.section !== 'Skip')
      .flatMap((s) => s.entries.map((e) => ({ title: e.heading, line: e.userFacing }))),
    operatorChanges: detail.notes.skipped.map((e) => ({
      title: e.heading ?? e.title,
      line: e.technical,
    })),
    unnoted: detail.notes.withoutNotes.map((i) => ({
      title: i.title,
      criteria: [...(unnotedCriteria.get(i.key) ?? [])],
    })),
    usersUnchanged: null,
  };
  return {
    ...facts,
    usersUnchanged: namingForOperatorsOnly(facts)
      ? usersUnchangedSentence(detail.notes.language)
      : null,
  };
}

function systemPrompt(
  facts: ReleaseNamingFacts,
  language: Parameters<typeof contentLanguageBlock>[0],
): string {
  const { min, max } = RELEASE_SUMMARY_SENTENCES;
  const operatorsOnly = namingForOperatorsOnly(facts);
  return [
    `You name release ${facts.version} for the people who use the product, and say in a few sentences what it brings them.`,
    'Your only input is below: each change this release carries, as its own note says it, or by what it was to do where it has no note. State nothing it does not hold, and nothing about any wider plan these changes belong to.',
    ...(operatorsOnly
      ? [
          'Nothing in this release changes what people using the product see: every change is one only those who run the product notice.',
          '- "name" says what it changes for those who run the product.',
          `- "summary" opens with exactly this sentence, as written: "${facts.usersUnchanged}" Then it says what changed for those who run the product.`,
        ]
      : []),
    '',
    'Rules:',
    '- Answer with one JSON object and nothing else: {"name": "...", "summary": "..."}.',
    `- "name" is at most ${RELEASE_NAME_WORDS_MAX} words naming what the release is about, never a list of its changes.`,
    `- "summary" is ${min} to ${max} whole sentences, each ending with a full stop${operatorsOnly ? '' : ', saying what a person can now do'}.`,
    '- Plain words only: no issue or requirement keys, no criterion codes, no commit ids, no file paths or routes, no error codes.',
    '- Every number you write appears in the input, as written there.',
    '',
    contentLanguageBlock(language, 'artifact'),
  ].join('\n');
}

const listed = (lines: string[]) => (lines.length > 0 ? lines : ['(none)']);

function factsInput(facts: ReleaseNamingFacts): string {
  return [
    '## Changes users see',
    ...listed(facts.changes.map((c) => `- ${c.title ? `${c.title}: ` : ''}${c.line}`)),
    '',
    '## Changes only those who run the product see',
    ...listed(facts.operatorChanges.map((c) => `- ${c.title}${c.line ? `: ${c.line}` : ''}`)),
    '',
    '## Changes with no note, by what each was to do',
    ...listed(
      facts.unnoted.map(
        (u) => `- ${u.title}${u.criteria.length > 0 ? `: ${u.criteria.join(' ')}` : ''}`,
      ),
    ),
  ].join('\n');
}

const SHAPE =
  'the answer is not one JSON object {"name": "...", "summary": "..."}; answer with that object and nothing else';

function parseAnswer(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** The drafted naming, or every reason it may not be written. */
export function judgedNaming(
  text: string,
  facts: ReleaseNamingFacts,
): { ok: true; naming: ReleaseNaming } | { ok: false; refusals: Refusal[] } {
  const raw = parseAnswer(text);
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, refusals: [{ code: 'RELEASE_NAMING_SHAPE', path: '', detail: SHAPE }] };
  }
  const refusals = judgeNaming(raw, facts);
  if (refusals.length > 0) return { ok: false, refusals };
  return { ok: true, naming: ReleaseNamingSchema.parse(raw) };
}

/** `remedy` says who names the release instead, where no later try will. */
function missOf(answer: Extract<CompletionAnswer, { ok: false }>, remedy: string): Refusal {
  if (answer.miss === 'unconfigured') {
    return {
      code: 'RELEASE_NAMING_MODEL_UNCONFIGURED',
      path: '',
      detail: `no chat model is configured on this instance, so no name was drafted: ${remedy}`,
    };
  }
  if (answer.miss === 'withheld') {
    return {
      code: 'RELEASE_NAMING_WITHHELD',
      path: '',
      detail: `the project's data policy forbids sending its release notes to a model, so no name was drafted: ${remedy}`,
    };
  }
  return {
    code: 'RELEASE_NAMING_MODEL_FAILED',
    path: '',
    detail: 'the model call failed; the name is drafted again on the next try',
  };
}

const said = (refusals: readonly Refusal[]) =>
  refusals.map((r) => `${r.code}${r.path ? ` at ${r.path}` : ''}: ${r.detail}`).join('; ');

/** Drafts and judges a release's name and summary, with one retry that carries the refusal. */
export async function draftReleaseNaming(
  projectId: string,
  facts: ReleaseNamingFacts,
): Promise<NamingOutcome> {
  const scope = {
    surface: 'requirement' as const,
    projectId,
    what: `the name of release ${facts.version}`,
  };
  const language = await readContentLanguage(projectId);
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt(facts, language) },
    { role: 'user', content: factsInput(facts) },
  ];
  const spent: { model: string; usage: ChatStreamUsage }[] = [];
  let model: string | null = null;
  try {
    for (const attempt of [1, 2]) {
      const answer = await completeOnce(scope, messages, {
        temperature: 0,
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (answer.model) model = answer.model;
      if (!answer.ok) {
        logger.warn(
          { projectId, version: facts.version, miss: answer.miss, detail: answer.detail },
          'release-page: the naming call did not answer',
        );
        const remedy = `a project admin names it (PUT /api/projects/${projectId}/releases/${facts.version}/naming)`;
        return { kind: 'missed', refusal: missOf(answer, remedy), model };
      }
      spent.push({ model: answer.model, usage: answer.usage });
      const verdict = judgedNaming(answer.text, facts);
      if (verdict.ok) return { kind: 'drafted', naming: verdict.naming, model: answer.model };
      if (attempt === 2) return { kind: 'refused', refusals: verdict.refusals, model };
      messages.push(
        { role: 'assistant', content: answer.text },
        {
          role: 'user',
          content: `That name was refused: ${said(verdict.refusals)}\nWrite it again by the same rules, from the same input, as one JSON object.`,
        },
      );
    }
    throw new Error('release-page: the naming loop ended without an outcome');
  } finally {
    await recordSpend(projectId, spent, 'naming');
  }
}
