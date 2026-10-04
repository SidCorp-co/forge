import type { MachineEntity } from '@forge/contracts/machines';
import {
  agentSessions,
  devices,
  issues,
  jobs,
  pipelineRuns,
  reconcileRuns,
  runners,
} from '../db/schema.js';
import { feedback } from '../db/schema-feedback.js';
import { mockups } from '../db/schema-mockups.js';
import { questionnaireBatches } from '../db/schema-onboarding.js';
import { agentQuestions } from '../db/schema-questions.js';
import { requirements } from '../db/schema-requirements.js';
import { scheduleRuns } from '../db/schema-schedule-runs.js';
import { suggestions } from '../db/schema-suggestions.js';

/** The table each machine's status lives on. */
export interface MachineTables {
  issue: typeof issues;
  job: typeof jobs;
  session: typeof agentSessions;
  run: typeof pipelineRuns;
  suggestion: typeof suggestions;
  feedback: typeof feedback;
  requirement: typeof requirements;
  mockup: typeof mockups;
  questionnaire: typeof questionnaireBatches;
  question: typeof agentQuestions;
  schedule_run: typeof scheduleRuns;
  reconcile_run: typeof reconcileRuns;
  runner: typeof runners;
  runner_provision: typeof runners;
  device: typeof devices;
}

export type MachineRow<E extends MachineEntity> = MachineTables[E]['$inferSelect'];

export interface MachineTable<E extends MachineEntity> {
  table: MachineTables[E];
  /** The row's id property and the property its status is held in. */
  idKey: string;
  statusKey: string;
}

/** Read on each call and never captured at module load, so a schema object is resolved when the
 *  move is made. A switch, so an entity with no table is refused by name rather than absorbed. */
export function machineTable<E extends MachineEntity>(entity: E): MachineTable<E> {
  const at = (table: MachineTables[MachineEntity], statusKey = 'status') =>
    ({ table, idKey: 'id', statusKey }) as MachineTable<E>;
  switch (entity as MachineEntity) {
    case 'issue':
      return at(issues);
    case 'job':
      return at(jobs);
    case 'session':
      return at(agentSessions);
    case 'run':
      return at(pipelineRuns);
    case 'suggestion':
      return at(suggestions);
    case 'feedback':
      return at(feedback);
    case 'requirement':
      return at(requirements);
    case 'mockup':
      return at(mockups);
    case 'questionnaire':
      return at(questionnaireBatches);
    case 'question':
      return at(agentQuestions);
    case 'schedule_run':
      return at(scheduleRuns);
    case 'reconcile_run':
      return at(reconcileRuns);
    case 'runner':
      return at(runners);
    case 'runner_provision':
      return at(runners, 'provisionStatus');
    case 'device':
      return at(devices);
    default:
      throw new Error(`lifecycle: no table holds the status of machine \`${entity}\``);
  }
}
