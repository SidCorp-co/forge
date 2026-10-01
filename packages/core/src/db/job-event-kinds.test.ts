import { describe, expect, it } from 'vitest';
import {
  CORE_WRITTEN_JOB_EVENT_KINDS,
  DEVICE_POSTED_JOB_EVENT_KINDS,
  jobEventKinds,
} from './job-event-kinds.js';

describe('job event kinds', () => {
  it('exports the kind enum values', () => {
    expect(jobEventKinds).toEqual([
      'stdout',
      'stderr',
      'tool_call',
      'tool_result',
      'progress',
      'result',
      'intervention',
      'kill_ack',
      'secret_resolve',
    ]);
  });

  it('lets a box post every kind but the ones core writes itself', () => {
    expect(DEVICE_POSTED_JOB_EVENT_KINDS).toEqual([
      'stdout',
      'stderr',
      'tool_call',
      'tool_result',
      'progress',
      'result',
    ]);
    for (const kind of CORE_WRITTEN_JOB_EVENT_KINDS) {
      expect(DEVICE_POSTED_JOB_EVENT_KINDS as readonly string[]).not.toContain(kind);
    }
  });
});
