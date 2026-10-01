import { describe, expect, it } from 'vitest';
import { doc, documentFiles, FORGE, PLUGIN } from './channel.fixture.js';
import { type Listed, rowsOf } from './channel-register.js';
import type { ThreadHold } from './channel-schema.js';

const published = (): Listed[] =>
  documentFiles()
    .map((f) => doc(f))
    .filter((d) => d.number)
    .map((d) => ({ ...d, thread: d.inReplyTo ?? d.number }) as Listed);

const byNumber = (today: string, held = new Map<string, ThreadHold>(), docs = published()) =>
  new Map(rowsOf(docs, held, today).map((r) => [r.number, r]));

describe('the register derives each document’s status, owner and hold on every read', () => {
  it('reads a notice answered by its acknowledgement, and an RFI by its decision', () => {
    const rows = byNumber('2026-10-02');
    expect(rows.get('FP-CN-12')).toMatchObject({
      open: false,
      owner: [],
      recipients: [{ project: PLUGIN, status: 'answered', answeredBy: 'FP-ACK-7' }],
    });
    expect(rows.get('FP-RFI-4')?.recipients[0]).toMatchObject({
      status: 'answered',
      answeredBy: 'FP-DEC-9',
    });
  });

  it('puts an unanswered change request in the court of its recipient, then overdue past its date', () => {
    expect(byNumber('2026-10-02').get('FP-CR-3')).toMatchObject({
      open: true,
      overdue: false,
      owner: [FORGE],
    });
    expect(byNumber('2026-10-12').get('FP-CR-3')).toMatchObject({
      open: true,
      overdue: true,
      recipients: [{ project: FORGE, status: 'overdue', answeredBy: null }],
    });
  });

  it('owes nothing on an acknowledgement or a decision', () => {
    const rows = byNumber('2026-10-02');
    for (const n of ['FP-ACK-7', 'FP-DEC-9']) {
      expect(rows.get(n)).toMatchObject({ open: false, recipients: [{ status: 'not-owed' }] });
    }
  });

  it('counts a withdrawn reply as no answer, and an ended document as owing nothing', () => {
    const docs = published().map((d) =>
      d.number === 'FP-ACK-7'
        ? ({ ...d, state: 'withdrawn', withdrawnReason: 'wrong' } as Listed)
        : d,
    );
    expect(byNumber('2026-10-02', new Map(), docs).get('FP-CN-12')).toMatchObject({
      open: true,
      owner: [PLUGIN],
    });
    const ended = published().map((d) =>
      d.number === 'FP-CR-3'
        ? ({ ...d, state: 'withdrawn', withdrawnReason: 'moot' } as Listed)
        : d,
    );
    expect(byNumber('2026-10-12', new Map(), ended).get('FP-CR-3')).toMatchObject({
      open: false,
      overdue: false,
    });
  });

  it('shows a hold on its thread, and an overdue reply stays overdue while held', () => {
    const hold = doc('FP-CR-3.hold.json') as ThreadHold;
    const row = byNumber('2026-10-12', new Map([['FP-CR-3', hold]])).get('FP-CR-3');
    expect(row).toMatchObject({ overdue: true, hold: { action: 'hold', side: FORGE } });
  });
});
