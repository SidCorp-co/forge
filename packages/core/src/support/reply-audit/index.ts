// The after-send audit of every stored room line (ISS-1250): one rubric
// (`@forge/contracts/support-reply-audit`), one judge, one verdict per line, and a failed one fed to
// the lessons store as a room correction.

import { consume } from '../../outbox/index.js';
import { auditStoredLine } from './audit.js';

export { auditStoredLine, fastModelJudge, noteLineStored } from './audit.js';
export { codeFindings, judgeLine, judgePrompt, type ReplyModel } from './judge.js';
export { roomLessonsNews } from './lessons-news.js';
export { replyVerdictsOf } from './read.js';
export { mountReplyVerdictRoutes } from './route.js';

/** Each stored room line, judged once, off the path that posted it. */
export function registerReplyAudit(): void {
  consume('support.replyStored', {
    name: 'support-reply-audit',
    handle: async (p) => {
      await auditStoredLine(p);
    },
  });
}
