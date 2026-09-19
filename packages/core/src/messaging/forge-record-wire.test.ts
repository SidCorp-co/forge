import type { ForgeRecordFieldView, ForgeRecordView, RecordLens } from '@forge/contracts';
import { describe, expect, it } from 'vitest';
import type { CommentRecord } from '../comments/tree.js';
import { parseForgeRecord } from './forge-record.js';
import type { RecordLens as CoreRecordLens } from './record-screen.js';

/** Each direction asserted separately, so the failure names which side grew. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

const coreIsTheWire: Exact<CommentRecord, ForgeRecordView & { readonly lens: RecordLens }> = true;
const lensIsTheWireLens: Exact<CoreRecordLens, RecordLens> = true;
const fieldIsTheWireField: Exact<
  NonNullable<ReturnType<typeof parseForgeRecord>>['fields'][number],
  ForgeRecordFieldView
> = true;

describe('the wire shape and the parse', () => {
  it('agrees in both directions, on the record, its lens and its fields', () => {
    expect([coreIsTheWire, lensIsTheWireLens, fieldIsTheWireField]).toEqual([true, true, true]);
  });

  it('parses into exactly the keys the wire type declares', () => {
    const fence = '```';
    const parsed = parseForgeRecord(
      `${fence}forge-record\nfinding: holds\n${fence}\n\n\`forge-record: confirmation · contract 1\``,
    );
    expect(Object.keys(parsed ?? {}).sort()).toEqual([
      'absent',
      'at',
      'contract',
      'fields',
      'kind',
      'lead',
      'to',
    ]);
  });
});
