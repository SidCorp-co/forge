import { defineReportQuery } from '@forge/contracts/report-queries';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('../project-status/index.js', () => ({ readProjectStatus: vi.fn() }));

import { checkedFrame, defineAdapter } from './adapter.js';

const descriptor = defineReportQuery({
  id: 'sample',
  version: 1,
  title: 'Sample',
  params: z.object({}),
  output: [{ name: 'n', type: 'number', label: 'N' }],
  permission: 'project.read',
  egress: 'product',
  surfaces: ['rest'],
});

describe('defineAdapter', () => {
  it('refuses a query that names no read, by id', () => {
    expect(() =>
      defineAdapter({ descriptor, reads: [], run: async () => ({ fields: [], rows: [] }) }),
    ).toThrow(/report query "sample": reads is empty/);
  });
});

describe('checkedFrame', () => {
  it('refuses a frame whose cell does not fit its field, naming the query', () => {
    const bad = { fields: [...descriptor.output], rows: [{ n: 'x' }] };
    expect(() => checkedFrame('sample', bad)).toThrow(
      /report query "sample" built a frame its own contract refuses/,
    );
  });

  it('returns a frame the contract accepts', () => {
    const ok = { fields: [...descriptor.output], rows: [{ n: 1 }] };
    expect(checkedFrame('sample', ok)).toEqual(ok);
  });
});
