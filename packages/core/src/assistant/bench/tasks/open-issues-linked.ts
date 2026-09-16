import type { Task } from '../task.js';

/**
 * The ISS-1041 walk, bounded: every link is a documentId under the project, and every one resolves.
 * The bound is the point — asked for every open issue on a project holding 682, the assistant
 * reasonably offered batches and asked how many were wanted, which measures patience rather than
 * linking (ISS-1066).
 */
export const openIssuesLinked: Task = {
  id: 'open-issues-linked',
  capability: 'method',
  intent:
    'List the five newest open issues in the project, one line each, with a link to each issue.',
  judgeRubric:
    'Served means the reply lists the issues openIssueKeys names in the reference block, newest first, one line each, each with a link.',
  budgetSeconds: 120,
  fixtures: ['newestOpenIssues'],
  turns: [
    {
      message:
        'List the five newest open issues in this project, one line each, with a link to each issue.',
      checks: [
        { kind: 'listInOrder', list: '{openIssueKeys}' },
        { kind: 'linkTo', issueId: '{openIssueId}' },
        { kind: 'linkShape' },
        { kind: 'linksResolve' },
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
