// A verdict refused by name, in the envelope both verdict doors answer (the REST door and a comment's
// verdict fence), each code at the path in the draft it names.

import { RefusalError } from '../../lib/refusal.js';
import type { VerdictRefusal } from './verdict-input.js';

const VERDICT_PATHS: Partial<Record<VerdictRefusal['code'], string>> = {
  VERDICT_JUDGED_BY_REVIEW: '/judge',
  VERDICT_JUDGED_BY_QA: '/judge',
  VERDICT_JUDGE_NOT_RUN_ROLE: '/judge',
  VERDICT_VALUE_UNKNOWN: '/verdict',
  VERDICT_SKIP_REASON_REQUIRED: '/reason',
  VERDICT_CLIP_REQUIRED: '/evidence',
  VERDICT_CAPTURE_REQUIRED: '/evidence',
  VERDICT_CRITERION_UNKNOWN: '/criterion',
  VERDICT_RUN_UNKNOWN: '/run',
  VERDICT_SESSION_NOT_ADMITTED: '/run',
};

/** A verdict refused by name, in the envelope both doors answer. */
export function verdictRefused(refusal: VerdictRefusal): RefusalError {
  return new RefusalError(
    [
      {
        code: refusal.code,
        path: refusal.path ?? VERDICT_PATHS[refusal.code] ?? '/identity',
        detail: refusal.detail,
      },
    ],
    'VERDICT_REFUSED',
  );
}
