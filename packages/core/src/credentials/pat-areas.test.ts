import { PAT_GRANT_AREAS } from '@forge/contracts/pat-areas';
import { describe, expect, it } from 'vitest';
import {
  PAT_ACCOUNT_ONLY_PERMISSIONS,
  PAT_EXPLICIT_PERMISSIONS,
  PAT_PERMISSION_NAMES,
} from './pat-permissions.js';

const menu = [...PAT_PERMISSION_NAMES, ...PAT_EXPLICIT_PERMISSIONS];
const placed = PAT_GRANT_AREAS.flatMap((a) => [...a.keys] as string[]);

describe('the grant menu as a person reads it, by area', () => {
  it('places every key the menu offers in an area', () => {
    expect(menu.filter((k) => !placed.includes(k))).toEqual([]);
  });

  it('places no key the menu does not offer, and none twice', () => {
    expect(placed.filter((k) => !menu.includes(k))).toEqual([]);
    expect(placed.filter((k, i) => placed.indexOf(k) !== i)).toEqual([]);
  });

  it('keeps the account permissions, which no project fence holds, in the account area alone', () => {
    const account = PAT_GRANT_AREAS.find((a) => a.id === 'account')?.keys ?? [];
    expect([...account].sort()).toEqual([...PAT_ACCOUNT_ONLY_PERMISSIONS].sort());
  });
});
