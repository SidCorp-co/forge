/**
 * The guards of a revision's kind and picture (REQ-35; Requirement lifecycle r14 edge `picture.drawn
 * or replaced`) as pure functions over what the service read: the content is the kind's, a rule's
 * table has an input and an expected result in every row, a text alternative is given, and a
 * superseded revision is evidence. Each refusal is named; nothing is written. No other guard reads a
 * picture (BC-14).
 */

import {
  type ExampleTableContent,
  PICTURE_KIND_OF,
  type PictureKind,
  type RequirementKind,
} from '@forge/contracts/requirement-pictures';
import type { RevisionState } from '@forge/contracts/requirements';
import type { RequirementRefusal } from './rules.js';

const KIND_NAMED: Record<PictureKind, string> = {
  flow: 'a flow',
  example_table: 'an example table',
  wireframe: 'a wireframe',
  chart: 'a sample chart',
};

/** The picture a revision takes is the one its kind names; a revision with no kind takes none yet. */
export function kindMismatchRefusal(
  key: string,
  revision: number,
  kind: RequirementKind | null,
  picture: PictureKind,
): RequirementRefusal | null {
  if (kind === null) {
    return {
      code: 'REQUIREMENT_PICTURE_KIND_MISMATCH',
      path: '/kind',
      detail: `${key} r${revision} names no kind, so no picture fits it yet; set its kind first (PUT …/revisions/${revision}/kind: process takes a flow, rule an example table, screen a wireframe, report a sample chart).`,
    };
  }
  const wanted = PICTURE_KIND_OF[kind];
  if (wanted === picture) return null;
  return {
    code: 'REQUIREMENT_PICTURE_KIND_MISMATCH',
    path: '/kind',
    detail: `${key} r${revision} is a ${kind} requirement, whose picture is ${KIND_NAMED[wanted]} (kind ${wanted}), not ${KIND_NAMED[picture]}; draw ${KIND_NAMED[wanted]}, or correct the revision's kind first.`,
  };
}

/** Every row of a rule's example table holds an input and the result expected of it (BC-4). */
export function rowRefusals(table: ExampleTableContent): RequirementRefusal[] {
  if (table.rows.length === 0) {
    return [
      {
        code: 'REQUIREMENT_PICTURE_ROW_INCOMPLETE',
        path: '/content/rows',
        detail: 'an example table holds at least one row, each an input and its expected result.',
      },
    ];
  }
  return table.rows.flatMap((row, i) => {
    const lacks = [
      ...(row.input?.trim() ? [] : ['input']),
      ...(row.expected?.trim() ? [] : ['expected result']),
    ];
    if (lacks.length === 0) return [];
    return [
      {
        code: 'REQUIREMENT_PICTURE_ROW_INCOMPLETE' as const,
        path: `/content/rows/${i}`,
        detail: `row ${i + 1} of the example table has no ${lacks.join(' and no ')}; each row is an input and the result it is expected to give.`,
      },
    ];
  });
}

/** A picture carries a short text alternative a screen reader reads in its place (BC-12). */
export function altRefusal(alt: string): RequirementRefusal | null {
  if (alt.trim()) return null;
  return {
    code: 'REQUIREMENT_PICTURE_ALT_REQUIRED',
    path: '/alt',
    detail:
      'a picture carries a short text alternative, read by a screen reader in its place; say in a sentence what it shows.',
  };
}

/** A superseded revision is evidence: its kind and picture stay as they were. */
export function supersededRefusal(
  key: string,
  revision: number,
  state: RevisionState,
  head: number | null,
  what: 'picture' | 'kind',
): RequirementRefusal | null {
  if (state !== 'superseded') return null;
  return {
    code: 'REQUIREMENT_REVISION_NOT_CURRENT',
    path: '/revision',
    detail: `${key} r${revision} is superseded${head === null ? '' : ` by r${head}`}, so its ${what} stays as it was; write the ${what} of r${head ?? revision} instead.`,
  };
}
