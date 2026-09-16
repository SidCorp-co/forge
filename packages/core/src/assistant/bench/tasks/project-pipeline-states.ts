import type { Task } from '../task.js';

/** Every pipeline state in the order the project's config declares them; one left out or out of place fails by name. */
export const projectPipelineStates: Task = {
  id: 'project-pipeline-states',
  capability: 'project-understanding',
  intent: 'List this project’s pipeline states in their configured order, by their exact keys.',
  judgeRubric:
    'Served means the reply lists the states in the order stateList gives in the reference block, using the keys as written there.',
  budgetSeconds: 180,
  fixtures: ['pipelineStates'],
  turns: [
    {
      message:
        'List this project’s pipeline states in order, from the first an issue enters to the last, using the exact state keys the pipeline config names.',
      checks: [
        { kind: 'listInOrder', list: '{stateList}' },
        // cm:why onlyFrom beside listInOrder: on 2026-09-16 the assistant listed the product's whole lifecycle and passed, since the three configured states stood in order among ten (ISS-1065)
        { kind: 'onlyFrom', list: '{stateList}' },
        { kind: 'notFallback' },
        { kind: 'noHelp' },
        { kind: 'noPlaceholder' },
      ],
    },
  ],
};
