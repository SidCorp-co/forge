// The two reads a followed release is matched by (ISS-1252, `match.ts`): the open items nearest its
// lead text by the stored vectors (requirements in `item_embeddings`, issues by core's copies of them
// in memory), and the fast model's judgement of one release against one open item. Each answers why
// where it has nothing, so a release no vector or no model can read is never matched by its words.

import { z } from 'zod';
import { callFastModelObject, type FastModelMiss } from '../integrations/llm/index.js';
import { embedText, nearestItems } from '../knowledge/index.js';
import { env } from '../lib/env.js';
import { nearestIssueCopies } from '../memory/index.js';
import {
  type JudgeRelease,
  type NearestOpen,
  type NearItem,
  type OpenItem,
  SHORTLIST_SIZE,
} from './match.js';

/** The notes the model reads: more than the lead, still short of the commit lists. */
const JUDGE_NOTES_CHARS = 3000;
const JUDGE_MAX_TOKENS = 400;
const WHAT = 'a followed release judged against an open item';

/** The open items nearest the release's lead: requirements and issues, each by its stored vector. */
export const nearestOpenItems: NearestOpen = async (projectId, lead, items) => {
  const own = await embedText(projectId, 'feedback', lead, 'a followed release');
  if (own.status !== 'embedded') {
    return { ok: false, why: `no vector for the release (${own.status}): ${own.error}` };
  }
  if (own.model !== env.EMBEDDINGS_MODEL) {
    return {
      ok: false,
      why: `the release was embedded by the fallback model ${own.model}, which core's issue copies were not`,
    };
  }
  const byId = new Map(items.map((i) => [i.id, i]));
  const of = (kind: OpenItem['kind']) => items.filter((i) => i.kind === kind).map((i) => i.id);
  const [requirements, issues] = await Promise.all([
    nearestItems({
      projectId,
      kind: 'requirement',
      vector: own.vector,
      model: own.model,
      among: of('requirement'),
      limit: SHORTLIST_SIZE,
    }),
    nearestIssueCopies({
      projectId,
      queryVec: own.vector,
      issueIds: of('issue'),
      limit: SHORTLIST_SIZE,
    }),
  ]);
  const near: NearItem[] = [
    ...requirements.map((n) => ({ id: n.itemId, similarity: n.similarity })),
    ...issues.map((n) => ({ id: n.issueId, similarity: n.similarity })),
  ].flatMap(({ id, similarity }) => {
    const item = byId.get(id);
    return item ? [{ item, similarity }] : [];
  });
  return { ok: true, near };
};

const verdict = z.object({ helps: z.boolean(), why: z.string().min(1) });

export function judgePrompt(release: Parameters<JudgeRelease>[1], item: OpenItem): string {
  return [
    'A project this team follows published a release. Decide whether the release concretely changes or fixes what the open item below describes.',
    'helps is true only when something the release itself ships does what the item asks for, or removes the problem the item names. A release that merely shares a topic area, a product kind or some words with the item is not a match: answer false.',
    'why: one sentence. When true, name what in the release does it; when false, say what the release is about instead.',
    `Open item ${item.ref}: ${item.title}`,
    `Release: ${release.source} ${release.name ?? release.tag}`,
    `Notes:\n${release.body.trim().slice(0, JUDGE_NOTES_CHARS)}`,
  ].join('\n\n');
}

const MISSED: Record<FastModelMiss, string> = {
  unconfigured: 'no fast model is set up to judge it',
  withheld: "the project's data policy keeps it from models",
  failed: 'the model call failed',
  unreadable: "the model's answer could not be read",
};

/** The fast model's judgement of one release against one open item. */
export const judgeRelease: JudgeRelease = async (projectId, release, item) => {
  const answer = await callFastModelObject(
    { surface: 'feedback', projectId, what: WHAT },
    judgePrompt(release, item),
    verdict,
    { maxTokens: JUDGE_MAX_TOKENS },
  );
  if (answer.ok) return { ok: true, helps: answer.value.helps, why: answer.value.why };
  return { ok: false, why: `not judged: ${MISSED[answer.miss]} (${answer.detail})` };
};
