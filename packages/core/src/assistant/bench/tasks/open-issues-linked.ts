import type { Task } from '../task.js';

/** The ISS-1041 walk: every link is a documentId under the project, and every one resolves. */
export const openIssuesLinked: Task = {
  id: 'open-issues-linked',
  budgetSeconds: 120,
  fixtures: ['firstOpenIssue'],
  turns: [
    {
      message: 'List the open issues in this project, one line each, with a link to each issue.',
      checks: [
        { kind: 'linkShape' },
        { kind: 'linksResolve' },
        { kind: 'mustMatch', patterns: ['{issueId}'] },
        { kind: 'toolsRequired', tools: ['forge'] },
        { kind: 'noHelp' },
        { kind: 'noPlaceholder' },
        { kind: 'noRepeatedCall' },
        { kind: 'maxCalls', max: 6 },
        { kind: 'screenRepair' },
      ],
    },
  ],
};
