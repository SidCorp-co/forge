import type { Task } from '../task.js';

/** One issue by its key: the reply links its documentId, which `forge issue` prints and the list does not. */
export const oneIssueByKey: Task = {
  id: 'one-issue-by-key',
  capability: 'method',
  intent: 'Describe one issue by its key in a paragraph and link to it.',
  budgetSeconds: 90,
  fixtures: ['firstOpenIssue'],
  turns: [
    {
      message: 'What is {issueKey} about? One paragraph, then a link to it.',
      checks: [
        { kind: 'linkShape' },
        { kind: 'linksResolve' },
        { kind: 'mustMatch', patterns: ['{issueId}'] },
        { kind: 'toolsRequired', tools: ['forge'] },
        { kind: 'noPlaceholder' },
        { kind: 'screenRepair' },
      ],
    },
  ],
};
