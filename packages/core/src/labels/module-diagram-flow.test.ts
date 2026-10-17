import { describe, expect, it } from 'vitest';
import { parseModuleFlow } from './module-diagram-flow.js';

const flow = (...lines: string[]) => ['```mermaid', 'flowchart LR', ...lines, '```'].join('\n');

/**
 * ISS-1229 r13, judge-30: forge-dev's User flow drew a step as `pipeline_run`, the id a module's flow
 * gave it with no text of its own. A reader is shown words, never the stored id.
 */
describe('a step a module flow names', () => {
  it('reads a step with no text of its own in words', () => {
    const parsed = parseModuleFlow(flow('pipeline_run --> review-gate'));
    expect(parsed?.steps.map((s) => s.label)).toEqual(['Pipeline run', 'Review gate']);
  });

  it('keeps the text a step was given', () => {
    const parsed = parseModuleFlow(flow('a[Open the issue] --> b(Run it)'));
    expect(parsed?.steps.map((s) => s.label)).toEqual(['Open the issue', 'Run it']);
  });

  it('takes the text a later line gives a step first named bare', () => {
    const parsed = parseModuleFlow(flow('pipeline_run --> b', 'pipeline_run[The run] --> c'));
    expect(parsed?.steps.find((s) => s.id === 'pipeline_run')?.label).toBe('The run');
  });
});
