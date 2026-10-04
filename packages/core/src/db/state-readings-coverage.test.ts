import { AGENT_REPORT_TRIAGES } from '@forge/contracts/agent-reports';
import { SCHEDULE_STATES } from '@forge/contracts/automation-standing';
import { MASTER_STATES } from '@forge/contracts/master-standing';
import { RUN_STATES, RUN_STUCK_RULES } from '@forge/contracts/run-standing';
import {
  SCHEDULE_KINDS,
  SCHEDULE_RUN_SKIP_REASONS,
  SCHEDULE_RUN_STATUSES,
  SCHEDULE_RUN_TRIGGERS,
} from '@forge/contracts/schedules';
import { ENUM_LABELS, STATE_READINGS } from '@forge/contracts/ui-vocabulary';
import { describe, expect, it } from 'vitest';
import { jobStatuses, pipelineRunStatuses } from './schema.js';
import { agentSessionStatuses } from './session-vocabulary.js';

// cm:why a badge family is a promise that every value core serves reads as words (ISS-110, REQ-15 BC-7): a
// value with no reading would fall back to its sentence-cased token, so each family is bound to the tuple core
// serves, member for member, and a missing or stray reading is named here
const FAMILIES = {
  runStanding: RUN_STATES,
  job: jobStatuses,
  pipelineRun: pipelineRunStatuses,
  masterState: MASTER_STATES,
  session: agentSessionStatuses,
  scheduleRun: SCHEDULE_RUN_STATUSES,
  scheduleStanding: SCHEDULE_STATES,
  reportTriage: AGENT_REPORT_TRIAGES,
} satisfies Partial<Record<keyof typeof STATE_READINGS, readonly string[]>>;

describe('each served state reads as words through its badge family', () => {
  for (const [family, served] of Object.entries(FAMILIES)) {
    it(`STATE_READINGS.${family} has one reading per value core serves`, () => {
      const readings = STATE_READINGS[family as keyof typeof FAMILIES] as Record<
        string,
        readonly [string, string, string?]
      >;
      const missing = served.filter((v) => !(v in readings));
      const stray = Object.keys(readings).filter((v) => !(served as readonly string[]).includes(v));
      expect(missing, `STATE_READINGS.${family} has no reading for: ${missing.join(', ')}`).toEqual(
        [],
      );
      expect(
        stray,
        `STATE_READINGS.${family} reads values core never serves: ${stray.join(', ')}`,
      ).toEqual([]);
    });

    it(`STATE_READINGS.${family} labels are sentence case and never the raw token`, () => {
      const readings = STATE_READINGS[family as keyof typeof FAMILIES] as Record<
        string,
        readonly [string, string, string?]
      >;
      for (const [value, [label]] of Object.entries(readings)) {
        expect(label, `${family}.${value}`).toMatch(/^[A-Z][^A-Z_]*$/);
        expect(label, `${family}.${value}`).not.toBe(value);
      }
    });
  }
});

describe('each stuck rule core serves reads as words', () => {
  it('ENUM_LABELS.runStuckRule names every RUN_STUCK_RULES value and no other', () => {
    expect(Object.keys(ENUM_LABELS.runStuckRule).sort()).toEqual([...RUN_STUCK_RULES].sort());
  });
});

describe('each schedule kind and fire trigger core serves reads as words', () => {
  it('ENUM_LABELS.scheduleKind names every SCHEDULE_KINDS value', () => {
    const missing = SCHEDULE_KINDS.filter((k) => !(k in ENUM_LABELS.scheduleKind));
    expect(missing, `ENUM_LABELS.scheduleKind has no label for: ${missing.join(', ')}`).toEqual([]);
  });

  it('ENUM_LABELS.fireTrigger names every SCHEDULE_RUN_TRIGGERS value and no other', () => {
    expect(Object.keys(ENUM_LABELS.fireTrigger).sort()).toEqual([...SCHEDULE_RUN_TRIGGERS].sort());
  });

  it('ENUM_LABELS.fireSkipReason names every SCHEDULE_RUN_SKIP_REASONS value and no other', () => {
    expect(Object.keys(ENUM_LABELS.fireSkipReason).sort()).toEqual(
      [...SCHEDULE_RUN_SKIP_REASONS].sort(),
    );
  });
});
