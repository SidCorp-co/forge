/** A shortfall's reason ("not marked merged", "holds 1 open question") as a sentence of its own. */
export function shortfallSentence(reason: string): string {
  const verb = /^(holds|has) /.test(reason) ? 'It' : /^no /.test(reason) ? 'It has' : 'It is';
  return `${verb} ${reason}.`;
}

export function shortfallSaid(s: { reason: string; clears: string }): string {
  return `${shortfallSentence(s.reason)} ${s.clears}`;
}
