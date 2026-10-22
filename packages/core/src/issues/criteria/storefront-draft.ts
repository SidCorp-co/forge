import type {
  StorefrontDraftPart,
  VerdictCorroboration,
  VerdictDraftReading,
} from '@forge/contracts/verdict-identity';
import {
  type IssueProjectDocument,
  readProjectDocument,
  readStorefrontDrafts,
  type StorefrontDraftReading,
} from '../ports.js';
import type { CriterionWithVerdict } from './store.js';
import type { VerdictRefusal } from './verdict-input.js';

interface DraftCorroboration {
  readonly corroboration: VerdictCorroboration;
  readonly note: string | null;
}

/** The draft the project's storefront source holds now of each workflow named, read once for all. */
export type DraftReader = (
  document: IssueProjectDocument | null,
  workflowIds: readonly string[],
) => Promise<Map<string, StorefrontDraftReading>>;

export function environmentFault(
  criterion: number,
  document: IssueProjectDocument | null,
  environment: string,
): VerdictRefusal | null {
  const declared = document ? Object.keys(document.environments) : [];
  const env = document?.environments[environment];
  if (env && env.tier !== 'production') return null;
  const detail = !document
    ? `criterion ${criterion} names environment \`${environment}\`, and this project declares no project document, so it declares no environment to judge a draft on.`
    : env
      ? `criterion ${criterion} names environment \`${environment}\`, whose tier is production: a storefront draft is unpublished, so it is judged on a preview, staging or dev environment, and a published version is judged at release.`
      : `criterion ${criterion} names environment \`${environment}\`, which the project document does not declare; it declares ${declared.map((k) => `\`${k}\``).join(', ') || 'none'}.`;
  return { code: 'VERDICT_ENVIRONMENT_UNKNOWN', criterion, detail };
}

const workflowNamed = (judged: StorefrontDraftPart, reading: StorefrontDraftReading) =>
  `workflow \`${judged.workflowId}\`${reading.kind === 'read' && reading.workflowCode ? ` (\`${reading.workflowCode}\`)` : ''}`;

/** What the source held of each part when the verdict was written: corroborated only when it held every one. */
export function corroborationOf(
  parts: readonly StorefrontDraftPart[],
  readings: ReadonlyMap<string, StorefrontDraftReading>,
): DraftCorroboration {
  const notes = parts.flatMap((judged) => {
    const reading = readings.get(judged.workflowId) ?? {
      kind: 'unreadable' as const,
      detail: `the draft reader answered no reading of workflow \`${judged.workflowId}\``,
    };
    if (reading.kind !== 'read') return [`${workflowNamed(judged, reading)}: ${reading.detail}`];
    if (reading.draftVersion === judged.draftVersion) return [];
    return [
      `the storefront source holds ${workflowNamed(judged, reading)} at draft version \`${reading.draftVersion}\` now, not \`${judged.draftVersion}\`: the draft moved after it was judged, or the version was not copied from the storefront target's \`workflows[].draftVersion\``,
    ];
  });
  return notes.length === 0
    ? { corroboration: 'corroborated', note: null }
    : { corroboration: 'uncorroborated', note: notes.join('; ') };
}

export const readSourceDrafts: DraftReader = async (document, workflowIds) => {
  const every = (detail: string) =>
    new Map(
      workflowIds.map((id): [string, StorefrontDraftReading] => [
        id,
        { kind: 'unreadable', detail },
      ]),
    );
  if (!document) {
    return every('this project declares no project document, so it names no storefront source');
  }
  const storefront = document.source.type === 'storefront' ? document.source.storefront : undefined;
  if (!storefront) {
    return every(
      `this project's source is \`${document.source.type}\`, not a storefront: no provider holds a draft of its work for core to read`,
    );
  }
  return readStorefrontDrafts({ ...storefront, workflowIds });
};

interface DraftReading {
  readonly corroboration: VerdictDraftReading;
  readonly note: string | null;
}

function currentDraftReading(
  judged: StorefrontDraftPart,
  reading: StorefrontDraftReading,
): DraftReading {
  if (reading.kind !== 'read') {
    return {
      corroboration: 'uncorroborated',
      note: `the draft the storefront source holds now could not be read, so nothing confirms workflow \`${judged.workflowId}\` is still at draft version \`${judged.draftVersion}\`: ${reading.detail}`,
    };
  }
  if (reading.draftVersion === judged.draftVersion)
    return { corroboration: 'corroborated', note: null };
  return {
    corroboration: 'superseded',
    note: `the storefront source holds ${workflowNamed(judged, reading)} at draft version \`${reading.draftVersion}\` now, not \`${judged.draftVersion}\`: the draft moved after it was judged, so the verdict is about a draft that will not ship`,
  };
}

/**
 * One verdict's reading over every workflow draft it names: corroborated only while the source holds
 * each of them; superseded where any one moved; uncorroborated where none moved and any one could not
 * be read. The note names every part that is not held, so a reader sees which (ISS-613).
 */
function verdictReading(readings: readonly DraftReading[]): DraftReading {
  const off = readings.filter((r) => r.corroboration !== 'corroborated');
  if (readings.length === 0) {
    return { corroboration: 'uncorroborated', note: 'the verdict names no workflow draft' };
  }
  if (off.length === 0) return { corroboration: 'corroborated', note: null };
  return {
    corroboration: off.some((r) => r.corroboration === 'superseded')
      ? 'superseded'
      : 'uncorroborated',
    note: off.map((r) => r.note).join('; '),
  };
}

export type CurrentDrafts = (judged: readonly StorefrontDraftPart[]) => DraftReading;

// a stored corroboration is what the source held when the verdict was written; every
// reader and every gate reads the drafts the source holds now instead, in one read for every
// workflow named, so a moved draft reads superseded and an unreadable one uncorroborated, never
// the word stored (FB-56) — over every part a verdict names, not only its first (ISS-613)
export async function readCurrentDrafts(
  projectId: string,
  workflowIds: readonly string[],
  readDraft: DraftReader = readSourceDrafts,
): Promise<CurrentDrafts> {
  let readings = new Map<string, StorefrontDraftReading>();
  if (workflowIds.length > 0) {
    const document = (await readProjectDocument(projectId))?.document ?? null;
    readings = await readDraft(document, [...new Set(workflowIds)]);
  }
  return (judged) =>
    verdictReading(
      judged.map((part) =>
        currentDraftReading(
          part,
          readings.get(part.workflowId) ?? {
            kind: 'unreadable',
            detail: `workflow \`${part.workflowId}\` was not among the drafts read`,
          },
        ),
      ),
    );
}

/** The storefront workflows the criteria's latest verdicts were judged at. */
function draftWorkflowIds(criteria: readonly CriterionWithVerdict[]): string[] {
  return criteria.flatMap((c) =>
    c.latest?.identityKind === 'storefront_draft'
      ? (c.latest.storefrontDrafts ?? []).map((p) => p.workflowId)
      : [],
  );
}

export async function withCurrentDrafts(
  projectId: string,
  criteria: readonly CriterionWithVerdict[],
  readDraft: DraftReader = readSourceDrafts,
): Promise<CriterionWithVerdict[]> {
  const workflowIds = draftWorkflowIds(criteria);
  if (workflowIds.length === 0) return [...criteria];
  return withDrafts(criteria, await readCurrentDrafts(projectId, workflowIds, readDraft));
}

/** The criteria with each draft verdict corroborated against drafts already read. */
function withDrafts(
  criteria: readonly CriterionWithVerdict[],
  current: CurrentDrafts,
): CriterionWithVerdict[] {
  return criteria.map((c) => {
    const latest = c.latest;
    if (latest?.identityKind !== 'storefront_draft') return c;
    const found = current(latest.storefrontDrafts ?? []);
    return {
      ...c,
      latest: { ...latest, corroboration: found.corroboration, corroborationNote: found.note },
    };
  });
}
