import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/declare/describe.js';
import { skillSchema } from './crud-routes-reference.js';

export const pinnedSchema = z.object({ skill: skillSchema });

export const pinSkill = describeOperation({
  summary: 'Pin a project skill against updates with a reason, or unpin it',
  description: 'A pin is the permanent, intentional divergence from the default template.',
  responses: {
    200: json(pinnedSchema, 'The skill after the change'),
    403: fail('FORBIDDEN', 'the caller is not a project admin'),
    404: fail('NOT_FOUND', 'there is no such skill in the project'),
  },
});
