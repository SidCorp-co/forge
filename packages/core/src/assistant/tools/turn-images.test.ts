import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({ env: { UPLOADS_MAX_BYTES: 10 * 1024 * 1024 } }));

import type { TurnImage } from '../vision.js';
import type { ChatToolset } from './mcp-adapter.js';
import { withTurnImages } from './turn-images.js';

const IMAGE: TurnImage = {
  name: 'shot.png',
  mime: 'image/png',
  ref: 'https://chat.example.com/file-upload/a/shot.png',
  dataBase64: 'QUJD',
};

function inner(): ChatToolset & { execute: ReturnType<typeof vi.fn> } {
  const execute = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '{"ok":true}' }] });
  return { tools: [], execute };
}

function attachmentsOf(spy: ReturnType<typeof vi.fn>): Array<{ name: string }> {
  const attachments = parsed(spy).data?.attachments;
  if (!Array.isArray(attachments)) throw new Error('the create call carried no attachments[]');
  return attachments as Array<{ name: string }>;
}

const parsed = (spy: ReturnType<typeof vi.fn>) =>
  JSON.parse(spy.mock.calls[0]?.[1] as string) as {
    action: string;
    data?: { attachments?: unknown[]; title?: string };
  };

describe('withTurnImages', () => {
  it('attaches the turn image to a created issue without the model asking', async () => {
    const set = inner();
    await withTurnImages(set, [IMAGE]).execute(
      'forge_issues',
      JSON.stringify({ action: 'create', data: { title: 'the toggle is stuck' } }),
    );
    expect(parsed(set.execute).data?.attachments).toEqual([
      { name: 'shot.png', mime: 'image/png', dataBase64: 'QUJD' },
    ]);
    expect(parsed(set.execute).data?.title).toBe('the toggle is stuck');
  });

  it('replaces attachments the model invented — it has no bytes to supply', async () => {
    const set = inner();
    await withTurnImages(set, [IMAGE]).execute(
      'forge_issues',
      JSON.stringify({
        action: 'create',
        data: { attachments: [{ name: 'made-up.png', mime: 'image/png', dataBase64: 'ZZZZ' }] },
      }),
    );
    expect(parsed(set.execute).data?.attachments).toEqual([
      { name: 'shot.png', mime: 'image/png', dataBase64: 'QUJD' },
    ]);
  });

  it('leaves an update alone — the image belongs to the report, not every edit', async () => {
    const set = inner();
    const args = JSON.stringify({ action: 'update', data: { issueId: 'i1', status: 'closed' } });
    await withTurnImages(set, [IMAGE]).execute('forge_issues', args);
    expect(set.execute).toHaveBeenCalledWith('forge_issues', args);
  });

  it('leaves another tool alone', async () => {
    const set = inner();
    const args = JSON.stringify({ action: 'create', data: { body: 'hi' } });
    await withTurnImages(set, [IMAGE]).execute('forge_comments', args);
    expect(set.execute).toHaveBeenCalledWith('forge_comments', args);
  });

  it('is the identity wrapper on a turn with no images', () => {
    const set = inner();
    expect(withTurnImages(set, [])).toBe(set);
  });

  it('passes unparseable arguments straight through so the guard reports them', async () => {
    const set = inner();
    await withTurnImages(set, [IMAGE]).execute('forge_issues', '{not json');
    expect(set.execute).toHaveBeenCalledWith('forge_issues', '{not json');
  });

  it('drops what would exceed UPLOADS_MAX_BYTES rather than failing the whole create', async () => {
    const set = inner();
    const big = {
      ...IMAGE,
      name: 'big.png',
      dataBase64: 'A'.repeat(Math.ceil((6 * 1024 * 1024 * 4) / 3)),
    };
    const second = { ...big, name: 'second.png' };
    await withTurnImages(set, [big, second, IMAGE]).execute(
      'forge_issues',
      JSON.stringify({ action: 'create' }),
    );
    expect(attachmentsOf(set.execute).map((a) => a.name)).toEqual(['big.png', 'shot.png']);
  });

  it('caps at the ten attachments forge_issues accepts', async () => {
    const set = inner();
    const many = Array.from({ length: 14 }, (_, i) => ({ ...IMAGE, name: `s${i}.png` }));
    await withTurnImages(set, many).execute('forge_issues', JSON.stringify({ action: 'create' }));
    expect(attachmentsOf(set.execute)).toHaveLength(10);
  });
});
