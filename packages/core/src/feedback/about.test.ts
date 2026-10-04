import type { SensitiveDataLevel } from '@forge/contracts/data-policy';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const PROJECT = '22222222-2222-4222-8222-222222222222';
const ROW = {
  id: '55555555-5555-4555-8555-555555555555',
  projectId: PROJECT,
  fbSeq: 9,
  kind: 'bug',
  severity: 'medium',
  title: 'SMS to 0912 345 678 at 2am',
  body: null,
  whereSeen: 'reminders',
  requirementId: null,
  issueId: null,
  releaseRunId: null,
  workflowId: null,
  status: 'new',
  route: null,
  routedIssueId: null,
  routedRequirementId: null,
  routedSuggestionId: null,
  duplicateOf: null,
  answer: null,
  reportedBy: '33333333-3333-4333-8333-333333333333',
  reporterAgency: 'human',
  redactedAt: null,
  dueAt: null,
  createdAt: new Date('2026-10-04T00:00:00Z'),
  updatedAt: new Date('2026-10-04T00:00:00Z'),
};

let level: SensitiveDataLevel = 'off';

vi.mock('../db/client.js', () => ({
  db: { select: () => ({ from: () => ({ where: async () => [ROW] }) }) },
}));

vi.mock('../lib/data-egress.js', async (actual) => ({
  ...(await actual<typeof import('../lib/data-egress.js')>()),
  dataPolicyOf: vi.fn(async () => level),
}));

vi.mock('./read.js', async (actual) => ({
  ...(await actual<typeof import('./read.js')>()),
  linkedOf: vi.fn(async () => ({
    prefix: null,
    issues: new Map(),
    requirements: new Map(),
    releases: new Map(),
    workflows: new Map(),
    providers: new Map(),
    suggestions: new Map(),
    roots: new Map(),
    names: new Map(),
  })),
}));

const { summariesAs } = await import('./about.js');

const agent = { userId: 'agent-1', agency: 'agent' as const };
const person = { userId: 'person-1', agency: 'human' as const };

beforeEach(() => {
  level = 'off';
});

describe('feedback read from a requirement passes the feedback egress rule (ISS-79)', () => {
  it('no_egress: an agent reads the key and the phase, never the title', async () => {
    level = 'no_egress';
    const [s] = await summariesAs(agent, PROJECT, [ROW.id]);
    expect(s?.key).toBe('FB-9');
    expect(s?.phase).toBe('new');
    expect(s?.title).toContain('content withheld');
    expect(s?.title).not.toContain('0912');
  });

  it('no_egress: a person on the MCP door is provider-bound too', async () => {
    level = 'no_egress';
    const [s] = await summariesAs(person, PROJECT, [ROW.id], { providerBound: true });
    expect(s?.title).toContain('content withheld');
  });

  it('redact: an agent reads the title scrubbed; a person off every provider door reads it as stored', async () => {
    level = 'redact';
    const [scrubbed] = await summariesAs(agent, PROJECT, [ROW.id]);
    expect(scrubbed?.title).not.toContain('0912');
    const [stored] = await summariesAs(person, PROJECT, [ROW.id]);
    expect(stored?.title).toBe(ROW.title);
  });
});
