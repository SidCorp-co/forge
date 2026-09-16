import type { Task } from '../task.js';

/** The counts are the project's own, read by the benchmark before the turn; each must stand beside its status, so a swap or a guess fails. */
export const projectIssueCounts: Task = {
  id: 'project-issue-counts',
  capability: 'project-understanding',
  intent:
    'Count this project’s open, closed and draft issues from the tracker and report all three.',
  judgeRubric:
    'Served means the three counts equal openCount, closedCount and draftCount, each named by its status; the brief’s counts-by-status line is the same project read earlier in the run and is background where it differs.',
  budgetSeconds: 180,
  fixtures: ['issueCounts'],
  turns: [
    {
      message:
        'How many issues does this project have that are open, how many are closed, and how many are still drafts? Give the three counts.',
      checks: [
        { kind: 'labeled', label: /open/i, value: '{openCount}' },
        { kind: 'labeled', label: /closed/i, value: '{closedCount}' },
        { kind: 'labeled', label: /drafts?/i, value: '{draftCount}' },
        { kind: 'toolsRequired', tools: ['forge'] },
        { kind: 'notFallback' },
        { kind: 'noHelp' },
        { kind: 'noPlaceholder' },
      ],
    },
  ],
};
