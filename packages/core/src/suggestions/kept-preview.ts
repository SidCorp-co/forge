// A kept idea preview written into the requirement record (REQ-41 BC-16): its picture, through the
// requirements module's own picture write, and the criteria drafted from what was asked, through the
// suggestions path a person accepts or rejects, never as a write into the revision.

import type { KeepPreviewResponse, KeptPreviewContent } from '@forge/contracts/preview';
import { chatModelName } from '../integrations/llm/index.js';
import { RefusalError } from '../lib/refusal.js';
import type { KeptPreviewWriter } from '../previews/index.js';
import { drawKeptPreview, liveCriteriaOf } from '../requirements/index.js';
import { createSuggestion } from './propose.js';
import { suggestionBaseOf } from './read.js';

/** The longest criterion a drafted ask becomes: the ask's own words, cut where the criterion limit would. */
const CRITERION_CHARS = 400;

/** What the keep drafts as criteria, one per thing asked: the person rewords them before accepting. */
export function criteriaFromAsked(asked: readonly string[]): { body: string }[] {
  return asked
    .map((a) => a.replace(/\s+/g, ' ').trim())
    .filter((a) => a !== '')
    .map((a) => ({
      body: `The page does what was asked: ${a.length > CRITERION_CHARS ? `${a.slice(0, CRITERION_CHARS - 1)}…` : a}`,
    }));
}

/** The model that drafted: none is named where the instance configures none, which a suggestion records as such. */
function modelName(): string | null {
  try {
    return chatModelName();
  } catch {
    return null;
  }
}

export const writeKeptPreview: KeptPreviewWriter['write'] = async (input) => {
  const { projectId, actor, about, content } = input;
  const drawn = await drawKeptPreview({
    projectId,
    actor,
    about,
    picture: { kind: 'preview', alt: input.alt, content },
  });
  if (!drawn.ok) {
    throw new RefusalError(
      drawn.refusals.map((r) => ({ code: r.code, path: r.path, detail: r.detail })),
      drawn.refusals[0]?.code ?? 'REQUIREMENT_REFUSED',
    );
  }
  return {
    requirement: drawn.key,
    revision: drawn.revision,
    pictureId: drawn.pictureId,
    startedFrom: drawn.created ? about.key : null,
    ...(await suggestCriteria({ projectId, actor, drawn, content })),
  };
};

/**
 * The criteria draft on the requirement: the requirement's live criteria ride along with their codes
 * (a revision_diff holds the whole list), the drafted ones after them, and its reason opens
 * "Recommended: accept". Where the suggestions path refuses the draft the keep still stands (the
 * picture is the person's act) and the answer carries that refusal by its code.
 */
async function suggestCriteria(args: {
  projectId: string;
  actor: { userId: string; agency: 'human' | 'agent' };
  drawn: { requirementId: string; key: string };
  content: KeptPreviewContent;
}): Promise<Pick<KeepPreviewResponse, 'suggestionId' | 'suggestionRefusal'>> {
  const { projectId, actor, drawn, content } = args;
  const drafted = criteriaFromAsked(content.asked);
  if (drafted.length === 0) return { suggestionId: null, suggestionRefusal: null };
  const live = await liveCriteriaOf(drawn.requirementId);
  const outcome = await createSuggestion({
    projectId,
    actor: { userId: actor.userId, agency: actor.agency },
    producerKind: 'ba_assistant',
    producerId: actor.userId,
    kind: 'revision_diff',
    target: { requirement: drawn.requirementId },
    baseRevision: await suggestionBaseOf(projectId, drawn.requirementId, 'revision_diff'),
    payload: {
      reason: `Recommended: accept. ${drafted.length === 1 ? 'One criterion' : `${drafted.length} criteria`} drafted from what was asked while the preview was built (${content.files.length} ${content.files.length === 1 ? 'file' : 'files'} changed); reword them before accepting.`,
      criteria: [...live, ...drafted],
    },
    model: modelName(),
  });
  if (!outcome.ok) {
    const first = outcome.refusals[0];
    return {
      suggestionId: null,
      suggestionRefusal: {
        code: first?.code ?? 'SUGGESTION_REFUSED',
        detail: first?.detail ?? 'the suggestions path refused the criteria draft',
      },
    };
  }
  return { suggestionId: outcome.suggestion.id, suggestionRefusal: null };
}
