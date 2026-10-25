// The assistant's draft of a release's highlights (REQ-40 BC-2, BC-3): one call through the gateway
// (`completeOnce`, so the deployment's provider and the project's data policy apply as they do to a
// chat turn), given the Product record of each requirement the release proves something of, and
// nothing else. The model writes each highlight's words and the codes it claims; the clip or picture
// is picked here, from that release's own QA evidence, never chosen by the model, and a highlight
// nothing shows is refused (REQ-70 BC-2). The answer is judged by `judgeHighlights`; a refused answer
// gets one retry carrying the refusal, then the draft is `failed` with what it was refused for. Where
// QA kept no clip or picture of anything the release proves, no model is asked: the draft is refused
// until the QA agent records one. The pattern is `reports/narrative.ts:writeTemplateNarrative`.

import { contentLanguageBlock } from '@forge/contracts/content-language';
import type { Refusal } from '@forge/contracts/refusal';
import {
  judgeHighlights,
  RELEASE_HIGHLIGHT_BODY_WORDS_MAX,
  RELEASE_HIGHLIGHT_TITLE_MAX,
  RELEASE_HIGHLIGHTS_MAX,
  type ReleaseHighlight,
  type ReleaseHighlightDraft,
  type ReleaseHighlightFacts,
  ReleaseHighlightSchema,
} from '@forge/contracts/release-page';
import { recordModelCallUsage } from '../agent-sessions/index.js';
import {
  type ChatMessage,
  type ChatStreamUsage,
  type CompletionAnswer,
  completeOnce,
} from '../integrations/llm/index.js';
import { logger } from '../lib/logger.js';
import { readContentLanguage } from '../project-config/index.js';
import { mediaForHighlight } from './highlights.js';

/** A hung provider cannot hold a refresh longer than this per call. */
const CALL_TIMEOUT_MS = 60_000;

export type DraftOutcome =
  | { kind: 'drafted'; highlights: ReleaseHighlight[]; model: string }
  | { kind: 'refused'; refusals: Refusal[]; model: string | null }
  | { kind: 'missed'; refusal: Refusal; model: string | null };

function systemPrompt(
  facts: ReleaseHighlightFacts,
  language: Parameters<typeof contentLanguageBlock>[0],
): string {
  const max = Math.min(
    RELEASE_HIGHLIGHTS_MAX,
    facts.requirements.filter((r) => r.media.length > 0).length,
  );
  return [
    `You write the highlights a reader sees first on the page of release ${facts.version}.`,
    "Your only input is the record of each requirement this release proves something of, below: its title, its own words, and the criteria a pass on this release's build lets it claim. Nothing else from the project is given to you, so state nothing it does not hold.",
    '',
    'Rules:',
    '- Answer with one JSON object and nothing else: {"highlights": [{"requirement": "<REQ key>", "title": "...", "body": "...", "claims": ["<BC code>", ...]}]}.',
    `- Write 1 to ${max} highlights, at most one per requirement, leading with what matters most to a person using the product.`,
    '- Write a highlight only for a requirement whose "Shown by" line names a clip or picture, and claim at least one code that line lists: every highlight shows one, and a requirement without one gets none.',
    `- "title" is at most ${RELEASE_HIGHLIGHT_TITLE_MAX} characters; "body" is at most ${RELEASE_HIGHLIGHT_BODY_WORDS_MAX} words saying what the reader can now do.`,
    '- "claims" names at least one code, and only codes listed as claimable for that requirement.',
    "- Every number you write appears in that requirement's record or in the version, as written there.",
    '',
    contentLanguageBlock(language, 'artifact'),
  ].join('\n');
}

function factsInput(facts: ReleaseHighlightFacts): string {
  return facts.requirements
    .map((r) =>
      [
        `## ${r.key}: ${r.title}${r.completes ? ' (completed by this release)' : ' (advanced by this release)'}`,
        r.text,
        `Claimable: ${r.claimable.join(', ')}`,
        r.media.length > 0
          ? `Shown by: a clip or picture QA kept of ${[...new Set(r.media.map((m) => m.criterion.bc))].join(', ')}`
          : 'Shown by: nothing QA kept, so no highlight',
      ].join('\n'),
    )
    .join('\n\n');
}

interface Drafted {
  requirement: string;
  title: string;
  body: string;
  claims: string[];
}

const SHAPE =
  'the answer is not one JSON object {"highlights": [{"requirement", "title", "body", "claims"}]} with strings and an array of codes; answer with that object and nothing else';

function parseAnswer(text: string): Drafted[] | string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return SHAPE;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return SHAPE;
  }
  const list = (parsed as { highlights?: unknown } | null)?.highlights;
  if (!Array.isArray(list)) return SHAPE;
  const ok = list.every((h) => {
    const x = h as Partial<Record<keyof Drafted, unknown>> | null;
    return (
      typeof x?.requirement === 'string' &&
      typeof x.title === 'string' &&
      typeof x.body === 'string' &&
      Array.isArray(x.claims) &&
      x.claims.every((c) => typeof c === 'string')
    );
  });
  return ok ? (list as Drafted[]) : SHAPE;
}

/** The highlight as drafted, with the clip or picture it shows: the first kept of its claims, clips first (`claims.ts:mediaOf` orders them), or none. */
function withMedia(d: Drafted, facts: ReleaseHighlightFacts): ReleaseHighlightDraft {
  const title = facts.requirements.find((r) => r.key === d.requirement)?.title ?? d.requirement;
  return {
    requirement: { key: d.requirement, title },
    title: d.title,
    body: d.body,
    claims: d.claims,
    media: mediaForHighlight(facts, d.requirement, d.claims),
  };
}

const DraftShape = ReleaseHighlightSchema.omit({ media: true });
const shows = (h: ReleaseHighlightDraft): h is ReleaseHighlight => h.media !== null;

/** The drafted highlights, or every reason they may not be shown. */
export function judged(
  text: string,
  facts: ReleaseHighlightFacts,
): { ok: true; highlights: ReleaseHighlight[] } | { ok: false; refusals: Refusal[] } {
  const parsed = parseAnswer(text);
  if (typeof parsed === 'string') {
    return { ok: false, refusals: [{ code: 'RELEASE_HIGHLIGHT_SHAPE', path: '', detail: parsed }] };
  }
  const drafts: ReleaseHighlightDraft[] = [];
  const refusals: Refusal[] = [];
  parsed.forEach((d, i) => {
    const { media, ...words } = withMedia(d, facts);
    const out = DraftShape.safeParse(words);
    if (out.success) drafts.push({ ...out.data, media });
    else
      refusals.push({
        code: 'RELEASE_HIGHLIGHT_SHAPE',
        path: `highlights.${i}.${out.error.issues[0]?.path.join('.') ?? ''}`,
        detail: out.error.issues[0]?.message ?? 'invalid',
      });
  });
  // the judge refuses a draft with no media, so a set it passes shows a clip or picture in each
  refusals.push(...judgeHighlights(drafts, facts));
  return refusals.length > 0
    ? { ok: false, refusals }
    : { ok: true, highlights: drafts.filter(shows) };
}

function missOf(answer: Extract<CompletionAnswer, { ok: false }>): Refusal {
  if (answer.miss === 'unconfigured') {
    return {
      code: 'RELEASE_HIGHLIGHTS_MODEL_UNCONFIGURED',
      path: '',
      detail: 'no chat model is configured on this instance, so no highlight was drafted',
    };
  }
  if (answer.miss === 'withheld') {
    return {
      code: 'RELEASE_HIGHLIGHTS_WITHHELD',
      path: '',
      detail:
        "the project's data policy forbids sending its requirements to a model, so no highlight was drafted",
    };
  }
  return {
    code: 'RELEASE_HIGHLIGHTS_MODEL_FAILED',
    path: '',
    detail: 'the model call failed; the highlights are drafted again on the next refresh',
  };
}

const said = (refusals: readonly Refusal[]) =>
  refusals.map((r) => `${r.code}${r.path ? ` at ${r.path}` : ''}: ${r.detail}`).join('; ');

/** Drafts and judges the highlights, with one retry that carries the refusal. */
export async function draftHighlights(
  projectId: string,
  facts: ReleaseHighlightFacts,
): Promise<DraftOutcome> {
  const scope = {
    surface: 'requirement' as const,
    projectId,
    what: `the highlights of release ${facts.version}`,
  };
  // nothing QA kept can show a highlight, so no model is asked until the QA agent records a clip
  if (facts.requirements.length > 0 && facts.requirements.every((r) => r.media.length === 0)) {
    return { kind: 'refused', refusals: judgeHighlights([], facts), model: null };
  }
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
          'release-page: the highlights call did not answer',
        );
        return { kind: 'missed', refusal: missOf(answer), model };
      }
      spent.push({ model: answer.model, usage: answer.usage });
      const verdict = judged(answer.text, facts);
      if (verdict.ok)
        return { kind: 'drafted', highlights: verdict.highlights, model: answer.model };
      if (attempt === 2) return { kind: 'refused', refusals: verdict.refusals, model };
      messages.push(
        { role: 'assistant', content: answer.text },
        {
          role: 'user',
          content: `Those highlights were refused: ${said(verdict.refusals)}\nWrite them again by the same rules, from the same record, as one JSON object.`,
        },
      );
    }
    throw new Error('release-page: the highlights loop ended without an outcome');
  } finally {
    await recordSpend(projectId, spent);
  }
}

/** Records what one draft's calls spent, as the project's model usage; a failure to record is logged, never thrown. */
export async function recordSpend(
  projectId: string,
  spent: readonly { model: string; usage: ChatStreamUsage }[],
  what: 'highlights' | 'naming' = 'highlights',
): Promise<void> {
  const last = spent.at(-1);
  if (!last) return;
  const sum = (key: keyof ChatStreamUsage) => spent.reduce((n, s) => n + (s.usage[key] ?? 0), 0);
  const cached = sum('cachedPromptTokens');
  try {
    await recordModelCallUsage({
      projectId,
      model: last.model,
      inputTokens: Math.max(0, sum('promptTokens') - cached),
      outputTokens: sum('completionTokens'),
      cacheReadTokens: cached,
      requestCount: spent.length,
      recordedAt: new Date(),
    });
  } catch (err) {
    logger.warn(
      { err, projectId },
      `release-page: the usage of the ${what} calls was not recorded`,
    );
  }
}
