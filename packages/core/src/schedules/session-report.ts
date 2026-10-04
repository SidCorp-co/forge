import { setSessionMetadata } from '../agent-sessions/index.js';
import { logger } from '../observability/logger.js';
import { extractReportFromMessages } from './messages/skill-improve-prompt.js';
import { extractStewardReportFromMessages } from './messages/skill-steward-prompt.js';
import { mergeAppliedMessageVersions } from './service.js';

/**
 * A completed session a schedule started writes its report back: a standing steward's run report
 * onto the session, a one-shot skill-improve's applied versions onto the schedule and its entries
 * onto the session. Best-effort; a session no schedule started writes nothing.
 */
export async function writeBackScheduleSession(session: {
  id: string;
  metadata: unknown;
  messages: unknown;
}): Promise<void> {
  const meta = session.metadata as Record<string, unknown> | null;
  const scheduleId = meta?.scheduleId;
  const templateKey = meta?.templateKey;
  if (typeof scheduleId !== 'string' || typeof templateKey !== 'string') return;
  try {
    const messages = Array.isArray(session.messages) ? session.messages : [];
    if (meta?.steward === true) {
      // a standing steward fires every run, so it writes no applied versions
      const stewardReport = extractStewardReportFromMessages(messages);
      if (stewardReport) {
        await setSessionMetadata(session.id, { ...(meta ?? {}), stewardReport });
      }
      return;
    }
    const report = extractReportFromMessages(messages);
    if (report && Object.keys(report.updatedVersions).length > 0) {
      await mergeAppliedMessageVersions(scheduleId, report.updatedVersions);
    }
    if (report) {
      await setSessionMetadata(session.id, { ...(meta ?? {}), skillImproveReport: report.entries });
    }
  } catch (err) {
    logger.error(
      { err, sessionId: session.id, scheduleId, templateKey },
      'schedules: a completed schedule session could not write its report back',
    );
  }
}
