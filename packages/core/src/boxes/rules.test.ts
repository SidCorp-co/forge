import { actKindOf } from '@forge/contracts/boxes';
import { describe, expect, it } from 'vitest';
import { actFault, deviceModeFault, modeFault } from './rules.js';

describe('a box mode', () => {
  it('refuses ios by name, saying no box serves it yet', () => {
    expect(modeFault('ios')).toMatchObject({
      code: 'BOX_MODE_UNAVAILABLE',
      detail: expect.stringMatching(/^no box serves ios yet: iOS needs a Mac/),
    });
  });

  it('refuses a mode that is no box mode, naming the three', () => {
    expect(modeFault('tv')?.detail).toBe(
      '"tv" is not a box mode: a box is one of browser, android, desktop',
    );
    expect(modeFault('android')).toBeNull();
  });

  it('refuses a mode the device lacks with what it lacks and the fix', () => {
    const report = {
      mode: 'android' as const,
      serves: false,
      lacks: ['adb', 'kvm group'],
      fix: '`forge-runner setup`',
      cost: { memoryMb: 4096, diskMb: 512, cpuCores: 3 },
      versions: {},
    };
    expect(deviceModeFault('android', report, true)?.detail).toBe(
      'this device cannot serve a android box: it lacks adb, kvm group. Fix: `forge-runner setup`',
    );
    expect(deviceModeFault('android', { ...report, serves: true }, true)).toBeNull();
    expect(deviceModeFault('android', null, false)?.code).toBe('BOX_MODE_UNAVAILABLE');
  });
});

describe("an agent's act while a person holds the box", () => {
  const held = { name: 'Chuong', since: new Date('2026-11-17T10:00:00Z') };

  it('refuses a write, naming who and since when', () => {
    const fault = actFault('person', actKindOf('browser', ['click', '@e22']), held);
    expect(fault?.code).toBe('BOX_HELD_BY_PERSON');
    expect(fault?.detail).toContain('Chuong has held it since 2026-11-17T10:00:00.000Z');
  });

  it('lets a read through, and an unlisted verb is a write', () => {
    expect(actFault('person', actKindOf('browser', ['snapshot', '-i']), held)).toBeNull();
    expect(actKindOf('android', ['eval', '1'])).toBe('write');
    expect(actKindOf('desktop', [])).toBe('write');
  });

  it('lets the agent write once the box is back at agent', () => {
    expect(actFault('agent', 'write', null)).toBeNull();
    expect(actFault('opening', 'read', null)?.code).toBe('BOX_NOT_READY');
    expect(actFault('closed', 'read', null)?.code).toBe('BOX_CLOSED');
  });
});
