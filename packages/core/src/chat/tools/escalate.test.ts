import { describe, expect, it } from 'vitest';
import { ESCALATE_TOOL_NAME, buildEscalationToolset } from './escalate.js';

describe('buildEscalationToolset', () => {
  it('exposes exactly one function tool named "escalate" requiring a question', () => {
    const toolset = buildEscalationToolset();
    expect(toolset.tools).toHaveLength(1);
    const tool = toolset.tools[0];
    expect(tool?.type).toBe('function');
    expect(tool?.function.name).toBe(ESCALATE_TOOL_NAME);
    expect(tool?.function.parameters).toMatchObject({
      type: 'object',
      required: ['question'],
    });
  });

  it('execute() returns a stub status without doing any real work', async () => {
    const toolset = buildEscalationToolset();
    const result = await toolset.execute('escalate', '{"question":"how does X work?"}');
    expect(JSON.parse(result)).toEqual({ status: 'escalation_queued' });
  });
});
