// What a run declared over a requirement rather than an issue is, and when it is refused (ISS-735).

import { judgesOnly } from '../issues/index.js';
import { RefusalError } from '../lib/refusal.js';
import { devicesPorts } from './ports.js';

/**
 * A run over a requirement rather than an issue (ISS-735): a judge of a shipped requirement at the
 * requirement, which owes no verifying issue (`requirement-lifecycle` guide). It takes no issue, so
 * it holds no lease and moves no step; it must be a judge's, name no issue beside it, and name a
 * requirement its project holds. Refused by name otherwise.
 */
export async function requirementSubject(args: {
  projectId: string;
  issueKeys: string[];
  requirement?: string;
  role?: string;
}): Promise<string | null> {
  if (args.requirement === undefined) {
    if (args.issueKeys.length === 0) {
      throw new RefusalError(
        [
          {
            code: 'RUN_SESSION_REFUSED',
            path: '/issueKeys',
            detail:
              'a run carries at least one issue, or the requirement a judge run judges (`requirement`)',
          },
        ],
        'RUN_SESSION_REFUSED',
      );
    }
    return null;
  }
  const key = args.requirement.toUpperCase();
  if (args.issueKeys.length > 0 || args.role === undefined || !judgesOnly(args.role)) {
    throw new RefusalError(
      [
        {
          code: 'RUN_REQUIREMENT_NOT_JUDGED',
          path: '/requirement',
          detail: `a run over ${key} judges it and does nothing else: declare it with a judging role (\`--role qa\` or \`reviewer\`) and no issue. Declared with role ${args.role ?? 'none'} and ${args.issueKeys.length} issue(s)`,
        },
      ],
      'RUN_SESSION_REFUSED',
    );
  }
  if (!(await devicesPorts().requirementIdOf(args.projectId, key))) {
    throw new RefusalError(
      [
        {
          code: 'RUN_REQUIREMENT_UNKNOWN',
          path: '/requirement',
          detail: `this project holds no ${key}, so no run can judge it`,
        },
      ],
      'RUN_SESSION_REFUSED',
    );
  }
  return key;
}
