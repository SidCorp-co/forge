import { type Task, validateTasks } from '../task.js';
import { filingGuidance } from './filing-guidance.js';
import { longContextNeedle } from './long-context-needle.js';
import { longContextThread } from './long-context-thread.js';
import { memoryCorrection } from './memory-correction.js';
import { memoryFollowup } from './memory-followup.js';
import { memoryQuestion } from './memory-question.js';
import { memoryStoreRecall } from './memory-store-recall.js';
import { oneIssueByKey } from './one-issue-by-key.js';
import { openIssuesLinked } from './open-issues-linked.js';
import { outOfReachTests } from './out-of-reach-tests.js';
import { preferenceBullets } from './preference-bullets.js';
import { preferenceRestore } from './preference-restore.js';
import { projectIssueCounts } from './project-issue-counts.js';
import { projectPipelineStates } from './project-pipeline-states.js';
import { projectWaitingIssue } from './project-waiting-issue.js';
import { summaryInStyle } from './summary-in-style.js';
import { vietnameseCount } from './vietnamese-count.js';

/** The shipped set, in the order a run walks it: the ten method tasks, then the seven capability tasks. */
export const SHIPPED_TASKS: readonly Task[] = [
  memoryQuestion,
  memoryFollowup,
  openIssuesLinked,
  oneIssueByKey,
  preferenceBullets,
  summaryInStyle,
  outOfReachTests,
  vietnameseCount,
  filingGuidance,
  preferenceRestore,
  // ISS-1061: what the assistant knows of the project, keeps for it, and holds across a long exchange
  projectIssueCounts,
  projectPipelineStates,
  projectWaitingIssue,
  memoryStoreRecall,
  memoryCorrection,
  longContextNeedle,
  longContextThread,
];

/** Every shipped task, validated whole; a list given is validated instead. */
export function loadTasks(list: readonly Task[] = SHIPPED_TASKS): Task[] {
  return validateTasks(list);
}
