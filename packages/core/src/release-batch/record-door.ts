// `POST /release-records`, past its validation and its act check: which record the body is, by the
// project's declared release and the version it names (ISS-1129, ISS-851, ISS-928).

import { resolveReleaseDeclaration } from './gate.js';
import { recordPromotionRelease } from './promotion-release.js';
import { recordPerformedRelease } from './recorded.js';
import { recordLanding } from './recorded-landing.js';
import { refuseRelease } from './refuse.js';
import { closeResidue, residueRelease } from './residue.js';
import { givenVersionOrRefuse } from './version-store.js';

/** The version a production release is recorded under, refused by name where missing or misshapen. */
function recordedVersion(sent: string | undefined): string {
  if (sent === undefined) {
    throw refuseRelease(
      'RELEASE_VERSION_MISSING',
      'A release is recorded under the version you released: send `version`, e.g. `v1.31.1`.',
      '/version',
    );
  }
  return givenVersionOrRefuse(sent);
}

/**
 * One release-record. Against a release that shipped and still carries a residue, it closes that
 * residue into it (ISS-928). With no production environment the landing is the delivery, under the
 * agent's version or one Forge cuts; anywhere else a release is the agent's record under the version
 * it shipped (owner, 2026-11-01), through its promotion where the project declares one.
 */
export async function recordRelease(sent: {
  projectId: string;
  userId: string;
  issueIds: string[];
  version?: string | undefined;
  commit?: string | undefined;
  account: string;
  providerRef?: string | undefined;
  branch?: string | undefined;
}) {
  const { projectId } = sent;
  const declared = await resolveReleaseDeclaration(projectId);
  if (sent.version !== undefined) {
    const shipped = await residueRelease(projectId, recordedVersion(sent.version));
    if (shipped) return closeResidue(sent, shipped);
  }
  if (declared?.kind === 'no-release') {
    // a landing takes the version the agent names, else one Forge cuts (REQ-45 r7 BC-11)
    const version = sent.version === undefined ? undefined : recordedVersion(sent.version);
    return recordLanding({ ...sent, version }, declared.defaultBranch);
  }
  if (sent.branch !== undefined) {
    throw refuseRelease(
      'RELEASE_RECORD_BRANCH_UNUSED',
      '`branch` names where a landing is recorded, and this project declares a production environment, whose record is the version it released: send the record without `branch`.',
      '/branch',
    );
  }
  const version = recordedVersion(sent.version);
  return declared?.kind === 'promotion'
    ? recordPromotionRelease({ ...sent, version }, declared)
    : recordPerformedRelease({ ...sent, version });
}
