/**
 * The record core parses and the record the browser is handed, held level.
 *
 * Core may not value-import `@forge/contracts` — it is absent from the
 * production image, so such an import compiles green and crashes at runtime,
 * which `contracts-runtime-boundary.test.ts` is the gate for. So the shape is
 * written twice and this file is what stops the two drifting: a field added on
 * either side and not the other fails the typecheck here, by name, before
 * anything reaches a browser that cannot draw it (ISS-1089).
 */

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
  // cm:guard the three constants above are the assertion and this case is what makes them run: a
  // type-only file vitest never loads is a green nothing proved, and the typecheck is what reds.
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
