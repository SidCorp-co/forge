// @generated codemap 0.16.0 — vendored by `cm install`; edit the plugin, not this.
// Which diagnostics from a `cm verify --json` report actually block an edit.
//
// Split out of hook-post-edit.mjs so metrics.mjs can ask the same question when it reconciles a
// pending block later — a second copy of this predicate would let the hook and the metrics it
// records disagree about what "blocked" ever meant.

export const PROSE_GRAMMAR_CODES = new Set(['CM001', 'CM010', 'CM011']);

/**
 * @param {{diags: Array, onboarded: boolean, baselineUnreadable: boolean}} report
 * @returns {Array} the diags that actually block, in report order
 */
export function blockingDiags(report) {
  const diags = report.diags ?? [];
  const enforceProse = report.onboarded && !report.baselineUnreadable;
  return diags.filter((d) => d.tier === 'grammar'
    && d.code !== 'CM009' && (enforceProse || !PROSE_GRAMMAR_CODES.has(d.code)));
}
