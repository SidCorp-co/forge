import { installationStandings } from '../integrations/github/index.js';
import {
  type BindingWithConnection,
  summarizeBinding,
  withBindingHealth,
} from '../integrations/index.js';

/** Bindings as a project reads them, each degraded where what reaches its target is gone. */
export async function summarizeBindings(pairs: readonly BindingWithConnection[]) {
  const [standings, read] = await Promise.all([
    installationStandings(pairs),
    withBindingHealth(pairs),
  ]);
  return read.map((pair) => summarizeBinding(pair, standings.get(pair.binding.id) ?? null));
}

export async function summarizeOneBinding(pair: BindingWithConnection) {
  const [summary] = await summarizeBindings([pair]);
  if (!summary) throw new Error('summarizeOneBinding: one binding summarized to none');
  return summary;
}
