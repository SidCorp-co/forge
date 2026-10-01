import type { EcosystemRefusal } from '../refusals.js';
import type { InterfaceDocument } from '../schema.js';
import type { StoredVersion } from './store.js';

export interface UploadBody {
  version?: string | undefined;
  artifact?: string | undefined;
  semantic?:
    | {
        classification: 'breaking' | 'non-breaking' | 'unknown';
        reason: string;
        elements: string[];
      }
    | undefined;
}

export function missingElements(
  elements: readonly string[],
  known: ReadonlySet<string> | null,
  path: (i: number) => string,
  where: string,
): EcosystemRefusal[] {
  if (!known) return [];
  return elements.flatMap((e, i) =>
    known.has(e)
      ? []
      : [
          {
            code: 'ELEMENT_NOT_IN_CONTRACT' as const,
            path: path(i),
            detail: `"${e}" is not an element of ${where}.`,
          },
        ],
  );
}

function semanticRefusals(
  body: UploadBody,
  latest: StoredVersion | null,
  ref: string,
): EcosystemRefusal[] {
  const s = body.semantic;
  if (!s) return [];
  const out: EcosystemRefusal[] = [];
  if (body.artifact !== undefined) {
    out.push({
      code: 'SEMANTIC_WITH_ARTIFACT',
      path: '/semantic',
      detail:
        'a semantic change is a behaviour change on an artifact that did not change; send the artifact and the declaration as two versions.',
    });
  }
  if (s.classification === 'non-breaking') {
    out.push({
      code: 'SEMANTIC_BELOW_UNKNOWN',
      path: '/semantic/classification',
      detail:
        'a declared semantic change is breaking or unknown; a change that keeps every consumer working needs no declaration.',
    });
  }
  if (latest) {
    const known = latest.elements ? new Set(latest.elements) : null;
    out.push(
      ...missingElements(
        s.elements,
        known,
        (i) => `/semantic/elements/${i}`,
        `${ref}@${latest.version}`,
      ),
    );
  }
  return out;
}

export function uploadRefusals(input: {
  project: { slug: string };
  contract: string;
  iface: InterfaceDocument | null;
  body: UploadBody;
  latest: StoredVersion | null;
}): EcosystemRefusal[] {
  const { project, contract, iface, body, latest } = input;
  const ref = `${project.slug}/${contract}`;
  const pub = iface?.publishes[contract];
  if (!pub) {
    return [
      {
        code: 'CONTRACT_NOT_PUBLISHED',
        path: '/',
        detail: `${project.slug} publishes no contract "${contract}" in its interface; a version is recorded for a published contract only.`,
      },
    ];
  }
  const out = semanticRefusals(body, latest, ref);
  const fromGit = pub.artifact !== null && 'path' in pub.artifact;
  if (body.artifact !== undefined && pub.type === 'opaque') {
    out.push({
      code: 'ARTIFACT_FOR_OPAQUE',
      path: '/artifact',
      detail: `${ref} is opaque, so it has no artifact to upload.`,
    });
  } else if (body.artifact !== undefined && fromGit) {
    out.push({
      code: 'ARTIFACT_MEASURED_FROM_GIT',
      path: '/artifact',
      detail: `${ref} is read from ${pub.artifact && 'path' in pub.artifact ? pub.artifact.path : 'its path'} at each land on a deployed branch; core reads those bytes itself and takes none from a caller.`,
    });
  }
  if (
    !body.semantic &&
    body.artifact === undefined &&
    pub.artifact !== null &&
    'upload' in pub.artifact
  ) {
    out.push({
      code: 'ARTIFACT_MISSING',
      path: '/artifact',
      detail: `${ref} is uploaded; send its text as artifact, or a semantic change.`,
    });
  }
  if (!body.semantic && fromGit && body.artifact === undefined) {
    out.push({
      code: 'NOTHING_TO_RECORD',
      path: '/',
      detail: `${ref} records a version when its artifact changes on a deployed branch; to declare a behaviour change its artifact does not show, send semantic.`,
    });
  }
  return out;
}
