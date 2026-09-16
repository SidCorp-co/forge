import type { Task } from '../task.js';

/** The one issue the tracker holds at needs_info, named by key and linked; its own fixture so a project without one skips only this task (codex F4). */
export const projectWaitingIssue: Task = {
  id: 'project-waiting-issue',
  capability: 'project-understanding',
  intent: 'Name the issue in this project that is waiting on information, with a link to it.',
  judgeRubric:
    'Served means the reply names needsInfoKey as the issue waiting on information and links it; the brief’s waiting-on-information line is the same project read earlier in the run and is background where it differs.',
  budgetSeconds: 180,
  fixtures: ['waitingIssue'],
  turns: [
    {
      message:
        'Which issue in this project is waiting on more information right now? Name it by key and link it.',
      checks: [
        { kind: 'mustMatch', patterns: ['{needsInfoKey}'] },
        { kind: 'linkTo', issueId: '{needsInfoId}' },
        { kind: 'linkShape' },
        { kind: 'linksResolve' },
        { kind: 'toolsRequired', tools: ['forge'] },
        { kind: 'notFallback' },
        { kind: 'noHelp' },
      ],
    },
  ],
};
