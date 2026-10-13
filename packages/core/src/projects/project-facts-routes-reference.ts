import { describeOperation, fail } from '../api-reference/describe.js';

const RETIRED =
  'always: project facts were retired, and the answer names the knowledge routes that replace them';

export const readProjectFacts = describeOperation({
  summary: 'Retired: project facts are read as knowledge entries',
  description:
    'Answers 410 for every caller. Read the knowledge store with `GET /api/projects/:id/knowledge` instead.',
  retired: 'project facts moved to knowledge entries (ISS-1048)',
  responses: { 410: fail('PROJECT_FACTS_RETIRED', RETIRED) },
});

export const patchProjectFacts = describeOperation({
  summary: 'Retired: project facts are written as knowledge entries',
  description:
    'Answers 410 for every caller. Write an entry with `PUT /api/projects/:id/knowledge/:slug` instead.',
  retired: 'project facts moved to knowledge entries (ISS-1048)',
  responses: { 410: fail('PROJECT_FACTS_RETIRED', RETIRED) },
});
