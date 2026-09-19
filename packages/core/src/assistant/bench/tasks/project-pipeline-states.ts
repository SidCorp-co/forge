import type { Task } from '../task.js';

export const projectPipelineStates: Task = {
  id: 'project-pipeline-states',
  capability: 'project-understanding',
  intent:
    'List this project’s effective pipeline states in order, from the first an issue enters to the last.',
  judgeRubric:
    'Served means the states listed are stateList, in that order and no others; the brief’s effective-pipeline line is the same sequence read earlier in the run, and the stored config’s override keys are not the answer.',
  budgetSeconds: 180,
  fixtures: ['pipelineStates'],
  turns: [
    {
      message:
        'What are this project’s pipeline states, in order, from the first an issue enters to the last? Give the state names as the pipeline uses them.',
      checks: [
        { kind: 'listInOrder', list: '{stateList}' },
        { kind: 'onlyFrom', list: '{stateList}' },
        { kind: 'notFallback' },
        { kind: 'noHelp' },
        { kind: 'noPlaceholder' },
      ],
    },
  ],
};
