// How a requirement's wait names a criterion (REQ-12 BC-6, ISS-1184): by its short title, never its
// code, which core still says beside it (`codes`).

import { criterionShortTitle } from '@forge/contracts/criterion-title';

export { joinNames, namesOf } from '../lib/named-items.js';

const firstLine = (body: string) =>
  body
    .split('\n')
    .find((l) => l.trim())
    ?.trim() ?? body;

/** A criterion as its row shows it: its short title, else the first clause of its wording; its code only where it has no words. */
export const criterionName = (c: { code: string; title?: string | null; body: string }): string =>
  criterionShortTitle({ title: c.title ?? null, text: firstLine(c.body) }).short || c.code;
