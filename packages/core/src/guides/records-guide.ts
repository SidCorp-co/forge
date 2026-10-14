// Body: content/records-and-comments.md, its routes filled in from record-screen.ts.
// Altitude (NT1): where each thing a run records belongs, not each store's schema.

import { ISSUE_ASSERTION_ROUTE, RECORD_GUIDE_SLUG } from '../messaging/record-screen.js';
import { guideBody } from './guide-content.js';
import type { ForgeGuide } from './types.js';

export const RECORDS_GUIDE: ForgeGuide = {
  slug: RECORD_GUIDE_SLUG,
  audience: 'agent',
  title: 'What a comment is for, and where a record goes',
  summary:
    'A comment carries what a person wrote for a person to read; a structured record goes to the store its kind names, with the comment keeping the pointer back.',
  version: 1,
  body: guideBody(RECORD_GUIDE_SLUG, {
    ISSUE_ASSERTION_ROUTE,
  }),
};
