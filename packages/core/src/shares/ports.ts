// What `shares` needs to freeze a subject, handed in by the process entry at boot: each subject kind
// (a message's blocks, a template's output, a stored status report) is frozen by the module that
// owns it, and `shares` never imports that module. A kind with no source registered is refused by
// name, never guessed at.

import type { ActorAgency } from '@forge/contracts/permissions';
import type { ReportDocument } from '@forge/contracts/report-templates';
import {
  SHARE_SUBJECT_KINDS,
  type ShareRefusalCode,
  type ShareSubjectKind,
} from '@forge/contracts/shares';
import type { ProjectAccess } from '../lib/authz.js';
import { refuser } from '../lib/refusal.js';

export const refuse = refuser<ShareRefusalCode>('SHARE_REFUSED');

/**
 * Freezes one subject into a report document, read now as the person creating the share: every run
 * the document holds is one that person can read at this moment, or the source refuses by name
 * (`SHARE_SUBJECT_NOT_FOUND`, or a permission refusal naming what they lack).
 */
export interface ShareSubjectSource {
  kind: ShareSubjectKind;
  freeze(input: {
    projectId: string;
    subjectId: string;
    userId: string;
    agency: ActorAgency;
    access: ProjectAccess;
  }): Promise<ReportDocument>;
}

const sources = new Map<ShareSubjectKind, ShareSubjectSource>();
let composed = false;

/** Adds one subject source; a second source for a kind is refused naming the kind. */
export function registerShareSubjectSource(source: ShareSubjectSource): void {
  if (sources.has(source.kind)) {
    throw new Error(`shares: a subject source for "${source.kind}" is already registered`);
  }
  sources.set(source.kind, source);
}

/** The process entry's one call: the subject sources this build has, possibly none yet. */
export function provideShareSubjectSources(list: readonly ShareSubjectSource[]): void {
  composed = true;
  for (const source of list) registerShareSubjectSource(source);
}

/** The source for `kind`, or a refusal naming the kind and the kinds this build can freeze. */
export function shareSubjectSource(kind: ShareSubjectKind): ShareSubjectSource {
  if (!composed) {
    throw new Error(
      'shares: no subject sources were provided; the process entry calls provideShareSubjectSources before it serves',
    );
  }
  const source = sources.get(kind);
  if (source) return source;
  const held = [...sources.keys()];
  throw refuse(
    'SHARE_SUBJECT_UNSUPPORTED',
    `a ${kind} cannot be shared yet: no source that freezes a ${kind} is registered in this build (registered: ${
      held.length > 0 ? held.join(', ') : 'none'
    }; subject kinds: ${SHARE_SUBJECT_KINDS.join(', ')})`,
    '/subjectKind',
  );
}
