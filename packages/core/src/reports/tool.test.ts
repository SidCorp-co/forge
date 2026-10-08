import { describe, expect, it } from 'vitest';
import type { McpContext } from '../lib/tool.js';
import { registerReportQueries } from '../report-queries/register.js';
import { getReportQuery, listReportQueries } from '../report-queries/registry.js';
import { provideReportsPorts } from './ports.js';
import { forgeReportTool, forgeShowTool } from './tool.js';

// The chat offers each tool a description of at most 1024 characters (assistant/tools/mcp-adapter.ts);
// a longer one is cut, and the model would never read the queries or block kinds past the cut.

registerReportQueries();
provideReportsPorts({
  runQuery: () => Promise.reject(new Error('not run here')),
  describeQuery: (id) => getReportQuery(id).descriptor,
  listQueries: () => listReportQueries().map((q) => q.descriptor),
  roomOf: () => Promise.reject(new Error('not read here')),
  messageOf: () => Promise.reject(new Error('not read here')),
  postAnswer: () => Promise.reject(new Error('not posted here')),
});
const ctx = { principal: { userId: 'u1' } } as unknown as McpContext;

describe('the report tools as the model reads them', () => {
  it('names every chat query in forge_report, whole, within the cap', () => {
    const { description } = forgeReportTool(ctx);
    for (const q of listReportQueries()) expect(description).toContain(q.descriptor.id);
    expect(description.length).toBeLessThanOrEqual(1024);
  });

  it('names every block kind in forge_show, within the cap', () => {
    const { description } = forgeShowTool(ctx);
    for (const kind of ['table', 'kpi', 'status-list', 'chart', 'timeline', 'flow'])
      expect(description).toContain(kind);
    expect(description.length).toBeLessThanOrEqual(1024);
  });
});
