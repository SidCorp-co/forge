// What the merge mark's `moduleMap` says to the agent that just landed work (ISS-1256): the one
// moment work finishes, so the sentence carries everything the write takes. A day of landings on
// forge-dev wrote no term or rule while it said "each term a person named": no person names a thing
// inside a landing, so every master read it as nothing to write. It now says what counts (the
// names the issue, its criteria, its decision or its code give a thing; a limit or choice the work
// settled), the whole shape of each write, and that the landing comment says what was written.
// Pure text: the module is the one an agent placed the issue in, never one derived here.

/** The calls that write a term and a rule under `module`, whole, so no second read is needed. */
export function landingWrite(base: string, module: string): string {
  return [
    `a term PUT ${base}/knowledge/<slug> { kind: 'glossary', module: '${module}', title, body, term: { aliases: { vi?, code?, industry? }, namedBy?: { who, quote } }, anchor: 'file.ts:symbol' }`,
    `a rule the same with kind: 'rule' and its source, scope and recheckWhen`,
  ].join('; ');
}

/** What counts as named, said once for both answers. */
export const LANDING_NAMED =
  'each name the issue, its criteria, its decision or its code gives a thing is a term, each limit or choice the work settled is a rule';

/** Where the agent says what it wrote, so a reader of the landing sees it or why none. */
export const LANDING_SAY = 'Say in the landing comment which you wrote, or why none.';

export function landingSaid(args: {
  base: string;
  issueId: string;
  module: { name: string; slug: string; terms: number; rules: number; recheckOwed: number } | null;
  roots: readonly string[];
  empty: number;
}): string {
  const { base, module, roots } = args;
  if (!module && roots.length === 0) {
    return `This project defines no module, so nothing can be placed or recorded under one. A module is created with POST ${base}/labels { kind: 'module', name }, which takes project.admin: ask a project admin to lay out the modules first.`;
  }
  if (!module) {
    return `This issue sits in no module, and ${args.empty} of ${roots.length} modules hold no term or rule. Place it by what it is about (PUT ${base}/modules/placements { type: 'issue', ref: '${args.issueId}', module }, module one of ${roots.join(', ')}), then write under that module what this landing named: ${LANDING_NAMED}. Write ${landingWrite(base, '<module>')}. ${LANDING_SAY}`;
  }
  const count = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;
  const owes =
    module.recheckOwed > 0
      ? `, ${module.recheckOwed} owing a re-check (fix each: GET ${base}/modules/${module.slug}/map)`
      : '';
  return `${module.name} holds ${count(module.terms, 'term')} and ${count(module.rules, 'rule')}${owes}. Write there what this landing named: ${LANDING_NAMED}. Write ${landingWrite(base, module.slug)}. ${LANDING_SAY}`;
}
