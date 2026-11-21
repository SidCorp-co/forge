// @direct-test-of packages/core/src/support/look-act.ts
// ISS-1356: a look reaches only the room's own project's environments. A command a look again runs
// may name an address only on one of them; any other is refused before it runs.

import { describe, expect, it } from 'vitest';
import { stepRefusal } from './look-act.js';

const OURS = new Set(['https://staging.adminhub.example', 'https://admin.adminhub.example']);

describe("a look's step stays on its project's environments", () => {
  it('lets a step naming no address, or one of its own environments, run', () => {
    expect(stepRefusal(['click', '@e12'], OURS)).toBeNull();
    expect(
      stepRefusal(['open', 'https://staging.adminhub.example/suppliers?tab=2'], OURS),
    ).toBeNull();
    expect(stepRefusal(['fill', '@e3', 'PGPrints'], OURS)).toBeNull();
    expect(stepRefusal(['tab', 'new'], OURS)).toBeNull();
  });

  it("refuses an address on another project's environment, another scheme or port, or a bare host", () => {
    for (const address of [
      'https://staging.epod.example/',
      'http://staging.adminhub.example/',
      'https://staging.adminhub.example:8443/',
      'file:///etc/passwd',
      'staging.epod.example/orders',
    ]) {
      expect(stepRefusal(['open', address], OURS), address).toMatch(
        new RegExp(
          `^${address.replace(/[.?/:]/g, '\\$&')} is on none of this project's environments`,
        ),
      );
    }
  });

  it('refuses a step that runs script in the page, which reaches any address', () => {
    expect(stepRefusal(['eval', "location.href='https://x.example'"], OURS)).toMatch(
      /^eval runs script/,
    );
  });
});
