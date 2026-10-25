// The release page's changes as users read them (REQ-40 BC-6, BC-16) and the steps its notes name
// for an admin (BC-7): `sections.ts:changesOf` and the written half of `actionsOf`.

import type { ReleaseShipped } from '@forge/contracts/release-page';
import type { ReleaseDetail } from '@forge/contracts/releases';
import { describe, expect, it } from 'vitest';
import { actionsOf, changesOf } from './sections.js';

const UNREAD: ReleaseShipped = { state: 'unread', why: 'planted' };
/** A release still to ship, which REQ-70's rules hold; one that ended reads as it ended. */
const OPEN = 'awaiting_approval' as const;
const NO_NOTES: ReleaseDetail['notes'] = {
  sections: [],
  designs: [],
  withoutNotes: [],
  skipped: [],
  reworked: [],
  language: 'en',
  attention: [],
};
const NO_CHANGES: ReleaseDetail['changes'] = {
  surfaces: [],
  risks: [],
  unclassified: [],
  boxRead: [],
  shipsNothing: false,
};

describe('improvements and fixes in user terms (BC-6)', () => {
  const entry = (
    key: string,
    userFacing: string,
    title = `title ${key}`,
    heading: string | null = `Heading ${key.slice(4)}`,
  ) => ({
    key,
    title,
    heading,
    userFacing,
    technical: null,
    adminSteps: [] as string[],
  });
  const notes = {
    sections: [
      { section: 'Added', entries: [entry('ISS-1', 'Nurses see reminders.')] },
      {
        section: 'Changed',
        entries: [
          entry('ISS-2', 'Reports load faster.', 'title ISS-2', 'Faster reports'),
          entry('ISS-3', 'Reports load faster.', 'title ISS-3', 'Faster reports'),
          entry('ISS-4', 'See ISS-9 for the reminder fix.'),
        ],
      },
      { section: 'Fixed', entries: [entry('ISS-5', 'A saved filter no longer resets.')] },
      { section: 'Security', entries: [entry('ISS-7', 'Reset links stop working once used.')] },
    ],
    designs: [],
    withoutNotes: [{ key: 'ISS-6', title: 'Untold change' }],
    skipped: [],
    reworked: [],
    language: 'en',
    attention: [],
  };
  const issues = [{ key: 'ISS-1', requirement: 'REQ-3' }] as ReleaseDetail['issues'];

  it('keeps each line with its issue, its requirement, the kind its section reads as, and the section itself', () => {
    const out = changesOf({ notes, issues, state: OPEN }, 'user');
    const line = (
      issueKey: string,
      kind: string,
      section: string,
      text: string,
      req: string | null = null,
      heading = `Heading ${issueKey.slice(4)}`,
    ) => ({
      issueKey,
      kind,
      section,
      line: heading,
      detail: text,
      requirementKey: req,
    });
    expect(out.improvements).toEqual([
      line('ISS-1', 'new', 'Added', 'Nurses see reminders.', 'REQ-3'),
      line('ISS-2', 'improved', 'Changed', 'Reports load faster.', null, 'Faster reports'),
    ]);
    // a Security entry reads as a fix and keeps its section, so the page groups it apart
    expect(out.fixes).toEqual([
      line('ISS-5', 'fixed', 'Fixed', 'A saved filter no longer resets.'),
      line('ISS-7', 'fixed', 'Security', 'Reset links stop working once used.'),
    ]);
  });

  // catalog-api 0.1.0: the page cut "Giờ đây, khi deploy lại thiết kế lên cửa hàng ePOD, …" at its // i18n-allow: catalog-api 0.1.0's own note, replayed as the test case
  // first comma; a titled note is its title, whole, and its sentence, whole. REQ-70 BC-3: a note with
  // no title, or saying two sentences, is held until its writer fixes it, never shown or cut
  it('shows a titled note as its short title with its sentence beside it, and holds an untitled or two-sentence one', () => {
    const sentence =
      'Giờ đây, khi deploy lại thiết kế lên cửa hàng ePOD, sản phẩm đã có được cập nhật tại chỗ thay vì báo lỗi trùng SKU.'; // i18n-allow: catalog-api 0.1.0's own note, replayed as the test case
    const out = changesOf(
      {
        notes: {
          ...notes,
          sections: [
            {
              section: 'Fixed',
              entries: [
                entry('ISS-3', sentence, 't', 'Deploy lại lên ePOD không còn báo lỗi trùng SKU'), // i18n-allow: catalog-api 0.1.0's own note, replayed as the test case
                entry('ISS-4', sentence.replace('SKU', 'mã'), 't', null), // i18n-allow: catalog-api 0.1.0's own note, replayed as the test case
                entry('ISS-5', `${sentence} ${sentence}`, 't', 'Hai câu'), // i18n-allow: catalog-api 0.1.0's own note, replayed as the test case
              ],
            },
          ],
        },
        issues,
        state: OPEN,
      },
      'user',
    );
    expect(out.fixes.map((c) => [c.line, c.detail])).toEqual([
      ['Deploy lại lên ePOD không còn báo lỗi trùng SKU', sentence], // i18n-allow: catalog-api 0.1.0's own note, replayed as the test case
    ]);
    expect(out.withoutNotes).toEqual([
      { issueKey: 'ISS-6', title: 'Untold change', why: 'no_note' },
      { issueKey: 'ISS-4', title: 't', why: 'untitled' },
      { issueKey: 'ISS-5', title: 't', why: 'not_one_sentence' },
    ]);
  });

  // the coordinator's ruling on REQ-70: a release that ended reads its notes as it ended with them
  it('reads a release that ended as it ended: an untitled note whole, a two-sentence note shown', () => {
    const ended = changesOf(
      {
        notes: {
          ...notes,
          sections: [
            {
              section: 'Fixed',
              entries: [
                entry('ISS-4', 'A saved filter no longer resets.', 't', null),
                entry('ISS-5', 'A saved filter stays. It survives a reload.', 't', 'Filter kept'),
              ],
            },
          ],
        },
        issues,
        state: 'shipped',
      },
      'user',
    );
    expect(ended.fixes.map((c) => [c.line, c.detail])).toEqual([
      ['A saved filter no longer resets.', null],
      ['Filter kept', 'A saved filter stays. It survives a reload.'],
    ]);
    expect(ended.withoutNotes).toEqual([
      { issueKey: 'ISS-6', title: 'Untold change', why: 'no_note' },
    ]);
  });

  it('names an issue with no line, and one whose line a reader cannot follow, rather than inventing one', () => {
    expect(changesOf({ notes, issues, state: OPEN }, 'user').withoutNotes).toEqual([
      { issueKey: 'ISS-6', title: 'Untold change', why: 'no_note' },
      { issueKey: 'ISS-4', title: 'title ISS-4', why: 'held' },
    ]);
  });

  // catalog-api 0.1.0: two contract-only issues (ISS-4, ISS-9) read as user changes
  it('counts what nobody using the product sees apart, and lists it on the developer view only (BC-16)', () => {
    const carried = {
      ...notes,
      sections: [
        ...notes.sections,
        { section: 'Changed', entries: [entry('ISS-8', 'Ships ISS-1.', 'Publish ISS-1')] },
      ],
      skipped: [entry('ISS-9', '-', 'Declare the report row schema')],
    };
    const user = changesOf({ notes: carried, issues, state: OPEN }, 'user');
    expect(user.internal).toEqual({ count: 2, changes: null });
    expect([...user.improvements, ...user.fixes].map((c) => c.issueKey)).not.toContain('ISS-9');
    expect(
      changesOf({ notes: carried, issues, state: OPEN }, 'developer').internal.changes,
    ).toEqual([
      { issueKey: 'ISS-9', title: 'Declare the report row schema', why: 'skip' },
      { issueKey: 'ISS-8', title: 'Publish ISS-1', why: 'carries' },
    ]);
  });
});

describe('an issue reworked after the release claimed it (BC-6, J9 on 0.4.0-dev.224)', () => {
  it('is named as reworked, never shown with the line its later round wrote', () => {
    const out = changesOf(
      {
        notes: {
          sections: [],
          designs: [],
          withoutNotes: [],
          skipped: [],
          reworked: [{ key: 'ISS-455', title: 'Intake drafts' }],
          language: 'en',
          attention: [],
        },
        issues: [],
        state: OPEN,
      },
      'user',
    );
    expect(out.fixes).toEqual([]);
    expect(out.withoutNotes).toEqual([
      { issueKey: 'ISS-455', title: 'Intake drafts', why: 'reworked' },
    ]);
  });
});

describe("the steps a release's notes name for an admin (BC-7)", () => {
  // catalog-api 0.1.0: five admin steps sat in the technical notes while the page said "Admin steps
  // not checked yet"
  it('lists each step its notes name first, once per sentence, with every issue that names it', () => {
    const step = (key: string, adminSteps: string[], userFacing = 'x') => ({
      key,
      title: key,
      heading: key,
      userFacing,
      technical: null,
      adminSteps,
    });
    const worker = 'Bật worker cho hai queue deploy-epod-insert và deploy-epod-delete.'; // i18n-allow: catalog-api 0.1.0's own note, replayed as the test case
    const notes = {
      ...NO_NOTES,
      sections: [
        {
          section: 'Added',
          entries: [step('ISS-1', ['Chạy migration cho nguồn site epod.', worker])], // i18n-allow: catalog-api 0.1.0's own note, replayed as the test case
        },
        { section: 'Changed', entries: [step('ISS-2', [worker])] },
      ],
      skipped: [step('ISS-9', ['Duyệt contract API admin-rest-v1 3.2.0.'], '-')], // i18n-allow: catalog-api 0.1.0's own note, replayed as the test case
    };
    const items = actionsOf(NO_CHANGES, UNREAD, notes);
    expect(items.map((i) => [i.kind, i.sentence, i.ref, i.issues])).toEqual([
      ['step', 'Chạy migration cho nguồn site epod.', null, ['ISS-1']], // i18n-allow: catalog-api 0.1.0's own note, replayed as the test case
      ['step', worker, null, ['ISS-1', 'ISS-2']],
      ['step', 'Duyệt contract API admin-rest-v1 3.2.0.', null, ['ISS-9']], // i18n-allow: catalog-api 0.1.0's own note, replayed as the test case
    ]);
  });
});
