// How a kept template report is shared: the `status-report` subject source of the Share port. The
// subject is the stored report's id; the frozen document is the `ReportDocument` as it was kept, so a
// shared report carries the narrative that was written for it (an empty slot stays empty, and the
// page does not draw it). A kept project status read has no document form, so it is refused by name
// rather than frozen into something it is not.

import type { ReportDocument } from '@forge/contracts/report-templates';
import { SHARE_SUBJECT_KINDS, type ShareRefusalCode } from '@forge/contracts/shares';
import { z } from 'zod';
import { refuser } from '../lib/refusal.js';
import type { ShareSubjectSource } from '../shares/index.js';
import { reportRow } from './store.js';

const refuseShare = refuser<ShareRefusalCode>('SHARE_REFUSED');

export const statusReportShareSource: ShareSubjectSource = {
  kind: SHARE_SUBJECT_KINDS[2],
  async freeze({ projectId, subjectId }): Promise<ReportDocument> {
    if (!z.uuid().safeParse(subjectId).success) {
      throw refuseShare(
        'SHARE_SUBJECT_NOT_FOUND',
        `"${subjectId}" is not a kept report; a status-report subject is the id of one report in this project's history`,
        '/subjectId',
      );
    }
    const row = await reportRow(projectId, subjectId);
    if (!row) {
      throw refuseShare(
        'SHARE_SUBJECT_NOT_FOUND',
        `status report ${subjectId} is not one of this project's kept reports`,
        '/subjectId',
      );
    }
    if (!row.document) {
      throw refuseShare(
        'SHARE_SUBJECT_UNSUPPORTED',
        `status report ${subjectId} is a project status read, which has no document to freeze; only a kept template report is shared`,
        '/subjectId',
      );
    }
    return row.document as ReportDocument;
  },
};
