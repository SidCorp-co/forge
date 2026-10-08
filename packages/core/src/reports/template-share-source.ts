// How a template's output is shared: the `template-output` subject source of the Share port. The
// subject is the template and the runs it made, named `<templateId>:<runId>,<runId>` in the template's
// query order; each run is read again, now, as the person creating the share, so a run that is
// another member's, past its keep, or whose permission they no longer hold refuses the share by name.
// The narrative is not kept anywhere a share can reach: it stays in the reply that wrote it, and the
// frozen document carries its blocks and runs with every slot empty.

import type { ReportDocument } from '@forge/contracts/report-templates';
import { SHARE_SUBJECT_KINDS, type ShareRefusalCode } from '@forge/contracts/shares';
import { isRefusal, refuser } from '../lib/refusal.js';
import type { ShareSubjectSource } from '../shares/index.js';
import { documentOf, readTemplateRuns, templateNamed } from './templates.js';

const refuseShare = refuser<ShareRefusalCode>('SHARE_REFUSED');

/** The subject id of one template run set, as `freeze` reads it back. */
export const templateOutputSubject = (templateId: string, runIds: readonly string[]): string =>
  `${templateId}:${runIds.join(',')}`;

export const templateShareSource: ShareSubjectSource = {
  kind: SHARE_SUBJECT_KINDS[1],
  async freeze({ projectId, subjectId, userId, agency }): Promise<ReportDocument> {
    const [templateId, list] = subjectId.split(':');
    const runIds = (list ?? '').split(',').filter(Boolean);
    if (!templateId || runIds.length === 0 || subjectId.split(':').length !== 2) {
      throw refuseShare(
        'SHARE_SUBJECT_NOT_FOUND',
        `"${subjectId}" is not a template output; a template output is shared as <templateId>:<runId>,<runId> with the run of each of the template's queries, in order`,
        '/subjectId',
      );
    }
    try {
      const t = templateNamed(templateId);
      const runs = await readTemplateRuns(t, { projectId, runIds, userId, agency });
      return documentOf(t, runs, { summary: '', risks: '', recommendations: '' }).document;
    } catch (err) {
      if (isRefusal(err, 'REPORT_TEMPLATE_NOT_FOUND')) {
        throw refuseShare('SHARE_SUBJECT_NOT_FOUND', err.refusals[0]?.detail ?? '', '/subjectId');
      }
      throw err;
    }
  },
};
