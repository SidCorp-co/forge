import { beforeEach, describe, expect, it, vi } from 'vitest';

const runForgeCli = vi.fn();
vi.mock('./forge-cli.js', () => ({ runForgeCli: (...args: unknown[]) => runForgeCli(...args) }));

import { toToolCallContent } from '../../mcp/tool-result.js';
import { forgeCliTool } from './forge-cli-tool.js';

const ctx = {
  principal: { userId: 'u1' },
  boundProjectId: 'p1',
  projectSlug: 'forge-plugin',
} as unknown as Parameters<typeof forgeCliTool>[0];

const handler = () =>
  forgeCliTool(ctx).handler as (raw: Record<string, unknown>) => Promise<unknown>;

beforeEach(() => runForgeCli.mockReset());

describe('a refusal is handed back as data AND audits as an error', () => {
  it('a non-zero exit carries the flag and the model still reads exitCode and stderr', async () => {
    runForgeCli.mockResolvedValue({ code: 1, stdout: '', stderr: 'Hold — one issue per problem' });
    const out = toToolCallContent(await handler()({ argv: ['new', '-'], body: '## Outcome' }));
    expect(out.isError).toBe(true);
    expect(out.content).toEqual([
      {
        type: 'text',
        text: JSON.stringify({ exitCode: 1, stdout: '', stderr: 'Hold — one issue per problem' }),
      },
    ]);
  });

  it('a verb the chat job does not open is refused before any credential, flagged the same way', async () => {
    const out = toToolCallContent(await handler()({ argv: ['doctor'] }));
    expect(out.isError).toBe(true);
    expect(runForgeCli).not.toHaveBeenCalled();
    expect(JSON.parse((out.content[0] as { text: string }).text)).toMatchObject({ exitCode: 2 });
  });

  it('exit 0 carries no flag', async () => {
    runForgeCli.mockResolvedValue({ code: 0, stdout: 'ISS-7 is filed', stderr: '' });
    const out = toToolCallContent(await handler()({ argv: ['new', '-'], body: '## Outcome' }));
    expect(out.isError).toBeUndefined();
    expect(JSON.parse((out.content[0] as { text: string }).text)).toEqual({
      exitCode: 0,
      stdout: 'ISS-7 is filed',
      stderr: '',
    });
  });
});
