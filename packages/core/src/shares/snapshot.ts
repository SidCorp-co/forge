// What a share freezes: the report document (or the release page) as the creator read it, then scrubbed. Every share drops
// secrets (`scrubSecretsDeep`) and email addresses wherever they sit; a link share open to anyone
// also passes the project's data policy on the `report.share` surface, which refuses it outright
// for a project at no_egress. The result must still be a valid report document, so a scrub that
// broke a frame is refused by name rather than stored half-readable.

import type { SensitiveDataLevel } from '@forge/contracts/data-policy';
import { type ReleasePageSnapshot, ReleasePageSnapshotSchema } from '@forge/contracts/release-page';
import { type ReportDocument, ReportDocumentSchema } from '@forge/contracts/report-templates';
import type { ShareAudience } from '@forge/contracts/shares';
import { scrubEmails, scrubSecretsDeep } from '@forge/observability';
import { egressAt } from '../lib/data-egress.js';
import { refuse } from './ports.js';

function emailsOut(v: unknown): unknown {
  if (typeof v === 'string') return scrubEmails(v);
  if (Array.isArray(v)) return v.map(emailsOut);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [scrubEmails(k), emailsOut(x)]),
    );
  }
  return v;
}

function parsed(raw: unknown, when: string): ReportDocument {
  const out = ReportDocumentSchema.safeParse(raw);
  if (out.success) return out.data;
  const issue = out.error.issues[0];
  const at = issue && issue.path.length > 0 ? issue.path.join('.') : '(document)';
  throw refuse(
    'SHARE_SNAPSHOT_INVALID',
    `the ${when} is not a report document: ${at}: ${issue?.message ?? 'invalid'}; a share freezes { templateId, version, params, runs, blocks, narrative } (@forge/contracts/report-templates:ReportDocumentSchema)`,
  );
}

/**
 * A link share's content through the project's data policy on the `report.share` surface: refused
 * by name at no_egress, scrubbed of personal data at redact, as it is at off.
 */
export function linkEgress<T>(level: SensitiveDataLevel, projectId: string, value: T): T {
  const out = egressAt(level, 'report.share', value, 'a link share');
  if (out.ok) return out.value;
  throw refuse(
    'SHARE_EGRESS_FORBIDDEN',
    `project ${projectId} keeps its data from leaving (data policy ${level}), so nothing of it can be shared with people outside it; share it with the project's members instead (audience "members"). The report.share surface is refused at this level (${out.refusal.code}).`,
    '/audience',
  );
}

/** The snapshot a share stores, or a refusal naming why this document cannot be shared. */
export function shareSnapshot(input: {
  document: unknown;
  projectId: string;
  audience: ShareAudience;
  level: SensitiveDataLevel;
}): ReportDocument {
  const document = parsed(input.document, 'subject as frozen');
  for (const run of document.runs) {
    if (run.projectId !== input.projectId) {
      throw refuse(
        'SHARE_SUBJECT_FOREIGN',
        `run ${run.runId} (${run.queryId}) was read in project ${run.projectId}, not ${input.projectId}; a share shows only its own project's runs`,
      );
    }
  }
  const held =
    input.audience === 'link' ? linkEgress(input.level, input.projectId, document) : document;
  return parsed(
    emailsOut(scrubSecretsDeep(held)),
    'subject once secrets and email addresses were removed',
  );
}

function parsedRelease(raw: unknown, when: string): ReleasePageSnapshot {
  const out = ReleasePageSnapshotSchema.safeParse(raw);
  if (out.success) return out.data;
  const issue = out.error.issues[0];
  const at = issue && issue.path.length > 0 ? issue.path.join('.') : '(page)';
  throw refuse(
    'SHARE_SNAPSHOT_INVALID',
    `the ${when} is not a release page's user view: ${at}: ${issue?.message ?? 'invalid'} (@forge/contracts/release-page:ReleasePageSnapshotSchema)`,
  );
}

/** A release page's snapshot, scrubbed as a report's is, or a refusal naming why it cannot be shared. */
export function releaseShareSnapshot(input: {
  document: unknown;
  projectId: string;
  audience: ShareAudience;
  level: SensitiveDataLevel;
}): ReleasePageSnapshot {
  const page = parsedRelease(input.document, 'release page as frozen');
  if (page.projectId !== input.projectId) {
    throw refuse(
      'SHARE_SUBJECT_FOREIGN',
      `the release page was read in project ${page.projectId}, not ${input.projectId}; a share shows only its own project's release`,
    );
  }
  const held = input.audience === 'link' ? linkEgress(input.level, input.projectId, page) : page;
  return parsedRelease(
    emailsOut(scrubSecretsDeep(held)),
    'release page once secrets and email addresses were removed',
  );
}
