import type { Task } from '../task.js';

/**
 * The project's EFFECTIVE pipeline, in order: the product's canonical ladder with this project's
 * stage overrides applied. Not the keys of the stored `pipelineConfig.states` map — that is
 * per-stage configuration, `forge-plugin` stores one of them, and asking for "the keys the config
 * names" pointed the assistant at exactly the one-state answer this task now rejects (ISS-1066).
 */
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
        // cm:why onlyFrom beside listInOrder: on 2026-09-16 the assistant listed the product's whole lifecycle and passed, since the three configured states stood in order among ten (ISS-1065)
        { kind: 'onlyFrom', list: '{stateList}' },
        { kind: 'notFallback' },
        { kind: 'noHelp' },
        { kind: 'noPlaceholder' },
      ],
    },
  ],
};
