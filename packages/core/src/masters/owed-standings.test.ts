import type { StandingSubjectKind } from '@forge/contracts/steward';
import { describe, expect, it } from 'vitest';
import { standingActsLine } from './owed-standings.js';
import type { StandingActOwed } from './ports.js';

// ISS-1282 (FB-710): the line ended "record why it waits as a decision on the item" and named no
// door, so a master wrote a requirement's wait on the issue delivering it, where nothing reads it,
// and the requirement was raised again on every pass. Each kind it lists is named with its own door.
// @direct-test-of packages/core/src/masters/decision-doors.ts

const act = (kind: StandingSubjectKind, key: string): StandingActOwed => ({
  subject: { kind, id: `${key}-id`, key },
  key: 'standing.act.proposeOrDrop',
  act: 'propose it for agreement, or drop it',
});

/** Each kind's door as its route takes a decision: the path and the field that carries its bound. */
const DOOR: Record<StandingSubjectKind, { item: StandingActOwed; door: string[] }> = {
  issue: {
    item: act('issue', 'ISS-7'),
    door: [
      'on an issue (ISS-7), `forge-runner api issues/<id>/events -X POST`',
      '{"kind":"decision","contract":1,',
      'plus a field `until` holding a date (ISO 8601, such as 2026-11-01) or a condition',
    ],
  },
  requirement: {
    item: act('requirement', 'REQ-23'),
    door: [
      'on a requirement (REQ-23), `forge-runner api projects/<projectId>/requirements/<key>/comments -X POST` with `intent: decision`',
      '`decision: { decision, reason, reversedWhen }`, `reversedWhen` inside `decision` holding a date (ISO 8601, such as 2026-11-01) or a condition',
    ],
  },
  feedback: {
    item: act('feedback', 'FB-36'),
    door: [
      'on a feedback item (FB-36), `forge-runner api projects/<projectId>/feedback/<key>/comments -X POST` with `intent: decision`',
      '`decision: { decision, reason, reversedWhen }`, `reversedWhen` inside `decision` holding a date (ISO 8601, such as 2026-11-01) or a condition',
    ],
  },
  workflow: {
    item: act('workflow', 'refunds'),
    door: [
      'on a workflow (refunds), `forge-runner api projects/<projectId>/workflows/<flow>/comments -X POST` with `intent: decision`',
      '`decision: { decision, reason, reversedWhen }`, `reversedWhen` inside `decision` holding a date (ISO 8601, such as 2026-11-01) or a condition',
    ],
  },
};

const PATHS: Record<StandingSubjectKind, string> = {
  issue: 'issues/<id>/events',
  requirement: 'requirements/<key>/comments',
  feedback: 'feedback/<key>/comments',
  workflow: 'workflows/<flow>/comments',
};

const KINDS = Object.keys(DOOR) as StandingSubjectKind[];

describe('standingActsLine: the decision door of each kind it lists (ISS-1282)', () => {
  it('a wake listing a requirement names its comments door with intent decision, never the issue door', () => {
    const line = standingActsLine([DOOR.requirement.item]);
    expect(line).toContain('REQ-23: propose it for agreement, or drop it');
    for (const part of DOOR.requirement.door) expect(line).toContain(part);
    expect(line).not.toContain(PATHS.issue);
    expect(line).toContain('a decision with a date to come or a condition takes the item off');
    // a dev.719 judge read "only as an ISO 8601 date" and then "other text there is a condition"
    expect(line).not.toContain('only as an ISO 8601 date');
    expect(line).not.toContain('other text there');
  });

  it.each(KINDS)(
    'a wake listing an item of kind %s names that kind’s door, and no absent kind’s',
    (kind) => {
      const line = standingActsLine([DOOR[kind].item]);
      for (const part of DOOR[kind].door) expect(line, `the ${kind} door`).toContain(part);
      for (const other of KINDS.filter((k) => k !== kind)) {
        expect(line, `the ${other} door, in a wake listing no ${other}`).not.toContain(
          PATHS[other],
        );
      }
    },
  );

  it('a wake listing every kind names every door, each once', () => {
    const line = standingActsLine(KINDS.map((k) => DOOR[k].item));
    for (const kind of KINDS) {
      expect(line.split(PATHS[kind]).length - 1, `the ${kind} door`).toBe(1);
    }
  });

  it('names nothing where nothing waits', () => {
    expect(standingActsLine([])).toBe('');
  });
});
