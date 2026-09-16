import { type Task, validateTasks } from '../task.js';
import { filingGuidance } from './filing-guidance.js';
import { memoryFollowup } from './memory-followup.js';
import { memoryQuestion } from './memory-question.js';
import { oneIssueByKey } from './one-issue-by-key.js';
import { openIssuesLinked } from './open-issues-linked.js';
import { outOfReachTests } from './out-of-reach-tests.js';
import { preferenceBullets } from './preference-bullets.js';
import { preferenceRestore } from './preference-restore.js';
import { summaryInStyle } from './summary-in-style.js';
import { vietnameseCount } from './vietnamese-count.js';

/** The shipped set, in the order a run walks it. */
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
];

/** Every shipped task, validated whole; a list given is validated instead. */
export function loadTasks(list: readonly Task[] = SHIPPED_TASKS): Task[] {
  return validateTasks(list);
}
