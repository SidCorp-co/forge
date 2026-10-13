import { z } from 'zod';
import { describeOperation, empty, fail, json } from '../api-reference/describe.js';
import { tableRow } from '../api-reference/rows.js';
import { tasks } from '../db/schema.js';
import { ISSUE_REF_REFUSALS } from '../issues/search-reference.js';

export const taskSchema = tableRow(tasks);
export const taskListSchema = z.array(taskSchema);

const ASSIGNEE_NOT_MEMBER = fail(
  'ASSIGNEE_NOT_MEMBER',
  '`assigneeId` is not a member of the project',
);
const NOT_A_WRITER = fail('FORBIDDEN', 'the caller is not a project member with write access');

export const createTaskRoute = describeOperation({
  summary: 'Add a subtask to an issue',
  responses: {
    201: json(taskSchema),
    400: ASSIGNEE_NOT_MEMBER,
    403: NOT_A_WRITER,
    404: fail('NOT_FOUND', 'the issue does not exist'),
  },
});

export const listTasksRoute = describeOperation({
  summary: "List an issue's subtasks in their order",
  responses: { 200: json(taskListSchema), ...ISSUE_REF_REFUSALS },
});

export const reorderTasksRoute = describeOperation({
  summary: "Set the order of all of an issue's subtasks",
  description:
    '`taskIds` must list every subtask of the issue exactly once, so the order stays gap-free.',
  responses: {
    204: empty(),
    400: fail(
      'TASKS_MISMATCH',
      '`taskIds` misses a subtask of the issue, repeats one, or names one that is not its own',
    ),
    403: NOT_A_WRITER,
    404: fail('NOT_FOUND', 'the issue does not exist'),
  },
});

export const readTaskRoute = describeOperation({
  summary: 'Read one subtask',
  responses: {
    200: json(taskSchema),
    403: fail('FORBIDDEN', "the caller is not a member of the task's project"),
    404: fail('NOT_FOUND', 'the task does not exist'),
  },
});

export const patchTaskRoute = describeOperation({
  summary: 'Change fields of a subtask',
  responses: {
    200: json(taskSchema),
    400: ASSIGNEE_NOT_MEMBER,
    403: NOT_A_WRITER,
    404: fail('NOT_FOUND', 'the task does not exist'),
  },
});

export const deleteTaskRoute = describeOperation({
  summary: 'Delete a subtask',
  responses: {
    204: empty(),
    403: NOT_A_WRITER,
    404: fail('NOT_FOUND', 'the task does not exist'),
  },
});
