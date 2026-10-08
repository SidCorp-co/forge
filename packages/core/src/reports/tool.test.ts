import { describe, expect, it } from 'vitest';
import type { McpContext } from '../lib/tool.js';
import { registerReportQueries } from '../report-queries/register.js';
import { getReportQuery, listReportQueries } from '../report-queries/registry.js';
import { provideReportsPorts } from './ports.js';
import { forgeComputeTool, forgeReportTool, forgeShowTool, forgeTemplateTool } from './tool.js';

// The chat offers each tool a description of at most 1024 characters (assistant/tools/mcp-adapter.ts);
// a longer one is cut, and the model would never read the queries or block kinds past the cut.

registerReportQueries();
provideReportsPorts({
  runQuery: () => Promise.reject(new Error('not run here')),
  describeQuery: (id) => getReportQuery(id).descriptor,
  listQueries: () => listReportQueries().map((q) => q.descriptor),
  roomOf: () => Promise.reject(new Error('not read here')),
  turnOf: () => Promise.reject(new Error('not read here')),
  postAnswer: () => Promise.reject(new Error('not posted here')),
  restTurnOf: () => Promise.reject(new Error('not read here')),
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

  it('names every template in forge_template, and the narrative check, within the cap', () => {
    const { description } = forgeTemplateTool(ctx);
    for (const id of ['progress', 'release', 'roadmap']) expect(description).toContain(id);
    expect(description).toContain('runIds and narrative');
    expect(description.length).toBeLessThanOrEqual(1024);
  });

  it('tells forge_compute the script is JavaScript reading Forge by GET, shown with its result, within the cap', () => {
    const { description } = forgeComputeTool(ctx);
    for (const word of [
      '"javascript"',
      'ctx.inputs',
      'ctx.forge.get',
      'cannot write',
      'forge_show',
      'computed',
      'show the script and its result',
      'confirms',
    ])
      expect(description).toContain(word);
    expect(description).not.toMatch(/python|bash/);
    expect(description.length).toBeLessThanOrEqual(1024);
  });
});
