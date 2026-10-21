// The web field refuses a long name before sending only while its limit is core's (ISS-1229 r29).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ORG_NAME_LIMIT } from './routes-reference.js';

const WEB_RULE = join(import.meta.dirname, '../../../web-v2/src/features/orgs/org-name.ts');

describe("an organization's name limit", () => {
  it('is the same number in the web field as in the rule core refuses by', () => {
    const declared = /export const ORG_NAME_LIMIT = (\d+);/.exec(readFileSync(WEB_RULE, 'utf8'));
    expect(Number(declared?.[1])).toBe(ORG_NAME_LIMIT);
  });
});
