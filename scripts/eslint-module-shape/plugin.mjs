// Pattern v2's semantic module rules (docs/patterns/core-module.md, ADR 0008) as type-aware
// ESLint rules over packages/core/src. scripts/check-module-shape.mjs runs them.

import globalFetch from './rules/global-fetch.mjs';
import refusal from './rules/refusal.mjs';
import routeQuery from './rules/route-query.mjs';
import tableWriter from './rules/table-writer.mjs';

export default {
  meta: { name: 'module-shape' },
  rules: {
    'table-writer': tableWriter,
    'route-query': routeQuery,
    refusal,
    'global-fetch': globalFetch,
  },
};
