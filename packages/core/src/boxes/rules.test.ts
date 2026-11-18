import { actKindOf } from '@forge/contracts/boxes';
import { describe, expect, it } from 'vitest';
import { actFault, attachFault, deviceModeFault, modeFault } from './rules.js';

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

describe('an attach (ISS-1322)', () => {
  const here = '6f1d0c3a-1b2c-4d5e-8f90-a1b2c3d4e5f6';
  const browser = {
    state: 'agent' as const,
    mode: 'browser' as const,
    deviceId: here,
    attach: { cdp: 'http://127.0.0.1:41733' },
  };

  it('hands a running browser box to an agent on its device, held by a person or not', () => {
    expect(attachFault(browser, here)).toBeNull();
    expect(attachFault({ ...browser, state: 'person' }, here)).toBeNull();
  });

  it('refuses a caller on another device or on none BOX_ATTACH_REMOTE, naming the act door', () => {
    const elsewhere = attachFault(browser, '0a1d0c3a-1b2c-4d5e-8f90-a1b2c3d4e5f6');
    expect(elsewhere?.code).toBe('BOX_ATTACH_REMOTE');
    expect(elsewhere?.detail).toContain('which no tunnel carries yet');
    expect(elsewhere?.detail).toContain('forge-runner box act');
    expect(attachFault(browser, null)?.detail).toMatch(
      /^the credential you call with is bound to no device/,
    );
  });

  it('refuses an android or desktop box BOX_ATTACH_UNAVAILABLE: nothing takes their endpoint back', () => {
    expect(attachFault({ ...browser, mode: 'android' }, here)).toMatchObject({
      code: 'BOX_ATTACH_UNAVAILABLE',
      detail: expect.stringMatching(/^an android box's adb serial cannot be taken back/),
    });
    expect(attachFault({ ...browser, mode: 'desktop' }, here)?.detail).toMatch(
      /DISPLAY and AT-SPI bus/,
    );
  });

  it('refuses a box whose device reported no endpoint, and one not running, by name', () => {
    expect(attachFault({ ...browser, attach: null }, here)?.detail).toMatch(/predates attach/);
    expect(attachFault({ ...browser, state: 'opening' }, here)?.code).toBe('BOX_NOT_READY');
    expect(attachFault({ ...browser, state: 'closed' }, here)?.code).toBe('BOX_CLOSED');
  });
});
