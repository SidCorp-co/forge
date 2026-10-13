import { describeOperation, fail, raw } from '../../api-reference/declare/describe.js';

const STREAM_REFUSALS = {
  400: fail({
    BAD_REQUEST: 'a query value is outside what the route takes',
    UNKNOWN_QUERY_PARAMETER:
      'a query parameter this route does not take; details lists the ones it does',
  }),
  403: fail('FORBIDDEN', 'the caller is not a member of the project'),
} as const;

export const streamOrdering = describeOperation({
  summary: "Stream the ordering inputs of a project's takeable issues",
  description:
    'One streamed call: a `meta` frame, the items, `progress` frames while the producer works, and exactly one terminal frame that says whether the stream ran out of rows or was cut off at `limit` or `budgetMs`.',
  responses: {
    200: raw('text/event-stream', 'the backlog stream: meta, items, progress, one terminal frame'),
    ...STREAM_REFUSALS,
  },
});

export const streamAlike = describeOperation({
  summary: 'Stream the issues of a project that look alike, from a search for each unsettled one',
  description:
    'One streamed call, framed as the ordering stream is. `topK` is how many neighbours each issue is searched for.',
  responses: {
    200: raw('text/event-stream', 'the backlog stream: meta, items, progress, one terminal frame'),
    ...STREAM_REFUSALS,
  },
});
