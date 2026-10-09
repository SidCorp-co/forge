/**
 * The entries a requirement's history writes for its revisions: written, proposed, withdrawn and
 * accepted, each rendered from what it says (`history-read.ts` reads the rows and orders them).
 */

import type { RequirementHistoryEntry } from '@forge/contracts/requirements';
import { type Said, say, sayEn } from '@forge/contracts/said';
import type { requirementRevisions } from '../db/schema-requirements.js';

type RevisionRow = typeof requirementRevisions.$inferSelect;

export interface Namer {
  who: (id: string | null, fallback: Said) => Said;
  sourceOf: (id: string | null) => 'person' | 'agent';
}

export const SOMEONE = say('requirements.history.who.someone');
export const SIGNER = say('requirements.history.who.signer');
export const AN_AGENT = say('requirements.history.who.agent');

type EntryInput = Omit<
  RequirementHistoryEntry,
  'issue' | 'move' | 'who' | 'text' | 'kind' | 'says'
> &
  Partial<Pick<RequirementHistoryEntry, 'issue' | 'move'>> & { who: Said; text: Said; kind: Said };

/** A history entry from what it says: its English `who`, `text` and `kind` rendered from `says`. */
export const entry = ({ who, text, kind, ...e }: EntryInput): RequirementHistoryEntry => ({
  issue: null,
  move: null,
  ...e,
  kind: sayEn(kind),
  who: sayEn(who),
  text: sayEn(text),
  says: { who, text, kind },
});

/** "Wrote r2: <why>", with its summary or reason; a revision written with neither says only that it was written. */
function writtenText(r: RevisionRow): Said {
  const rest = r.changeSummary ?? r.reason;
  if (rest === null) {
    return r.fromSuggestionId
      ? say('requirements.history.text.wroteSuggestedBare', { r: r.revision })
      : say('requirements.history.text.wroteBare', { r: r.revision });
  }
  return r.fromSuggestionId
    ? say('requirements.history.text.wroteSuggested', { r: r.revision, rest })
    : say('requirements.history.text.wrote', { r: r.revision, rest });
}

export function revisionEntries(r: RevisionRow, n: Namer): RequirementHistoryEntry[] {
  const out = [
    entry({
      id: `rev-${r.revision}-written`,
      at: r.createdAt.toISOString(),
      source: n.sourceOf(r.authorId),
      who: n.who(r.authorId, SOMEONE),
      kind: say('requirements.history.kind.Revision'),
      text: writtenText(r),
    }),
  ];
  if (r.proposedAt) {
    out.push(
      entry({
        id: `rev-${r.revision}-proposed`,
        at: r.proposedAt.toISOString(),
        source: n.sourceOf(r.proposedBy ?? r.authorId),
        who: n.who(r.proposedBy ?? r.authorId, SOMEONE),
        kind: say('requirements.history.kind.Revision'),
        text: say('requirements.history.text.proposed', { r: r.revision }),
      }),
    );
  }
  if (r.state === 'withdrawn' && r.withdrawnAt) {
    out.push(
      entry({
        id: `rev-${r.revision}-withdrawn`,
        at: r.withdrawnAt.toISOString(),
        source: n.sourceOf(r.withdrawnBy ?? r.authorId),
        who: n.who(r.withdrawnBy, SOMEONE),
        kind: say('requirements.history.kind.Revision'),
        text: say('requirements.history.text.withdrawn', {
          r: r.revision,
          rest: r.withdrawnReason ?? '',
        }),
      }),
    );
  }
  if (r.decidedAt && (r.state === 'current' || r.state === 'superseded')) {
    out.push(
      entry({
        id: `rev-${r.revision}-accepted`,
        at: r.decidedAt.toISOString(),
        source: 'person',
        who: n.who(r.decidedBy, SIGNER),
        kind: say('requirements.history.kind.Decision'),
        text: r.acceptReason
          ? say('requirements.history.text.acceptedWhy', { r: r.revision, rest: r.acceptReason })
          : say('requirements.history.text.accepted', { r: r.revision }),
      }),
    );
  }
  return out;
}

// Each picture written is its own row (requirement_pictures), so a replaced one stays here with who
// drew it and when (Requirement lifecycle r14 `picture_shown`); a picture is a replace where one was
// already drawn for the same revision
