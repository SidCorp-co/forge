/**
 * The window's ledger: what the next reader needs to reconstruct the order taken, the tree each
 * member was proved on and why any member left. JSON beside the manifest for the tool, markdown
 * for the comment each member's issue carries.
 */

const WINDOW_ID = /^[a-z0-9][a-z0-9-]{1,40}$/;

/** A manifest's shape, refused by name. @returns {{ refusal: string } | { manifest: object }} */
export function readManifest(raw) {
  if (typeof raw?.window !== 'string' || !WINDOW_ID.test(raw.window)) {
    return {
      refusal:
        '`window` must be a lowercase kebab id of 2 to 41 characters; it names the branch the window is pushed to',
    };
  }
  if (typeof raw.base !== 'string' || raw.base === '')
    return { refusal: '`base` must name the branch the window lands on' };
  if (!Array.isArray(raw.members) || raw.members.length === 0)
    return { refusal: '`members` must list at least one member, in landing order' };
  const seen = new Set();
  for (const [i, m] of raw.members.entries()) {
    for (const k of ['issue', 'branch', 'head', 'arrivedAt']) {
      if (typeof m?.[k] !== 'string' || m[k] === '')
        return { refusal: `members[${i}] carries no \`${k}\`` };
    }
    if (!/^[0-9a-f]{40}$/.test(m.head))
      return { refusal: `members[${i}].head must be a full 40-character commit, not ${m.head}` };
    if (seen.has(m.issue))
      return { refusal: `${m.issue} is listed twice; a member enters a window once` };
    seen.add(m.issue);
  }
  return { manifest: { isolated: [], ...raw } };
}

function cell(v) {
  return String(v ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ');
}

export function renderLedger(ledger) {
  const out = [
    `## Verify window ${ledger.window}`,
    '',
    `- Base: ${ledger.base.branch} at \`${ledger.base.sha}\``,
    `- Thresholds: ${ledger.thresholds ? `count ${ledger.thresholds.count}, wait ${ledger.thresholds.waitHours}h, read from ${ledger.thresholds.source}` : 'none recorded'}`,
    `- Declarations: ${ledger.declarations}`,
    `- Open branches outside the window read for migration numbers: ${ledger.openBranches.length}`,
    `- Combination: \`${ledger.chain.head}\`, ${ledger.chain.landed} member(s) entered`,
    '',
    '| # | Issue | Branch | Reviewed head | Arrived | Admission | Landing |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const [i, m] of ledger.members.entries()) {
    const landing = m.landing
      ? `\`${m.landing.slice(0, 12)}\``
      : m.isolated
        ? 'isolated'
        : 'refused';
    out.push(
      `| ${i + 1} | ${m.issue} | ${cell(m.branch)} | \`${m.head.slice(0, 12)}\` | ${m.arrivedAt} | ${m.admission} | ${landing} |`,
    );
  }
  const notes = [];
  for (const m of ledger.members) {
    for (const r of m.refusals ?? []) notes.push(`- ${m.issue} refused at admission: ${r}`);
    if (m.isolated) notes.push(`- ${m.issue} isolated (${m.isolated.kind}): ${m.isolated.because}`);
    for (const mv of m.renumbered ?? []) {
      notes.push(
        `- ${m.issue} renumbered ${mv.from.tag} (idx ${mv.from.idx}, when ${mv.from.when}) to ${mv.to.tag} (idx ${mv.to.idx}, when ${mv.to.when})`,
      );
    }
    if (m.rewrites?.length)
      notes.push(`- ${m.issue}: the old tag was rewritten in ${m.rewrites.join(', ')}`);
    if (m.unions?.length) notes.push(`- ${m.issue}: both sides kept in ${m.unions.join(', ')}`);
  }
  for (const a of ledger.attributions ?? [])
    notes.push(`- Attribution (${a.kind}${a.owner ? `, ${a.owner}` : ''}): ${a.says}`);
  if (ledger.validation) {
    notes.push(
      `- Validation: ${ledger.validation.check} at \`${ledger.validation.at}\` is ${ledger.validation.state ?? ledger.validation.refusal}${ledger.validation.url ? ` (${ledger.validation.url})` : ''}`,
    );
  }
  if (notes.length > 0) out.push('', ...notes);
  out.push(
    '',
    'Each member lands as its own merge commit, so a revert names one change; the window bought one validation, not one commit.',
  );
  return `${out.join('\n')}\n`;
}
