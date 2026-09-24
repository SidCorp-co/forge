/**
 * The Sentry answers and the fetch stub `agent-read.test.ts` reads against.
 *
 * Apart so that file stays under the size budget; the `vi.mock` factories stay with the tests,
 * because a mock factory is hoisted above the imports of the file that declares it.
 */

import { vi } from 'vitest';

export const TOKEN = 'sntryu_the_secret_token_value';
export const PROJECT = 'p-1';

export interface Pair {
  binding: Record<string, unknown>;
  connection: Record<string, unknown>;
}

export function pair(
  over: { binding?: Record<string, unknown>; connection?: Record<string, unknown> } = {},
): Pair {
  return {
    binding: {
      id: 'b-1',
      provider: 'sentry',
      projectId: PROJECT,
      active: true,
      agentAccess: 'all',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      config: {
        host: 'logs.canawan.com',
        targets: [{ label: 'core', organizationSlug: 'canawan', projectSlug: 'forge-core' }],
      },
      ...over.binding,
    },
    connection: { id: 'c-1', active: true, secrets: { authToken: TOKEN }, ...over.connection },
  };
}

/** Two targets under one organization — forge-dev's own shape, and where a guess writes wrong. */
export const TWO_TARGETS = [
  { label: 'core', organizationSlug: 'canawan', projectSlug: 'forge-core' },
  { label: 'web', organizationSlug: 'canawan', projectSlug: 'forge-web' },
];

export function sentryIssue(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '5001',
    shortId: 'FORGE-CORE-7',
    status: 'unresolved',
    substatus: 'ongoing',
    level: 'error',
    count: 1,
    userCount: 1,
    firstSeen: '2026-09-24T10:00:00Z',
    lastSeen: '2026-09-24T11:00:00Z',
    permalink: 'https://logs.canawan.com/organizations/canawan/issues/5001/',
    project: { slug: 'forge-core' },
    title: 'TypeError: cannot read x',
    culprit: 'GET /api/issues',
    metadata: { value: 'cannot read x' },
    ...over,
  };
}

export const calls: string[] = [];

/** One fetch answer per call, in order; a string body stands for a non-JSON answer. */
export function answerWith(
  ...answers: Array<{ status?: number; body?: unknown; link?: string }>
): void {
  let n = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(String(url));
      const answer = answers[Math.min(n++, answers.length - 1)] ?? {};
      const status = answer.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name: string) => (name === 'link' ? (answer.link ?? null) : null) },
        json: async () => answer.body,
      };
    }),
  );
}

export async function refusalOf(run: () => Promise<unknown>): Promise<{
  reason: string;
  message: string;
  httpStatus: number | null;
}> {
  try {
    await run();
  } catch (err) {
    const refusal = err as { reason: string; message: string; httpStatus: number | null };
    return { reason: refusal.reason, message: refusal.message, httpStatus: refusal.httpStatus };
  }
  throw new Error('the call answered where a refusal was planted');
}
