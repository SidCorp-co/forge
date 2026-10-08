// Body: content/conformance-and-verify.md.

import { guideBody } from './guide-content.js';
import type { ForgeGuide } from './types.js';

export const CONFORMANCE_GUIDE: ForgeGuide = {
  slug: 'conformance-and-verify',
  audience: 'agent',
  title: 'Conformance gates & `pnpm verify`',
  summary:
    'Run verify before you claim a step is done, and what each exit code obliges you to do — especially exit 2, which is never a pass.',
  version: 1,
  body: guideBody('conformance-and-verify'),
};
