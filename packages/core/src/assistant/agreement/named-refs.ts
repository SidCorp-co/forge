// A card names what it changes the way a person knows it (REQ-30 BC-4: the card shows what will be
// written and what it relates to): an issue by its key and title, a requirement by its key and
// title, a design by its flow. An Agent session's CLI resolves keys to ids before it sends, so a held
// request often names only a uuid, and a card reading "Change 31a41b51-…" asks a person to agree to
// a change they cannot recognise. A uuid that names none of these is left as it stands.

import type { ChatProposalSummary } from '@forge/contracts/chat-proposals';
import { issueKeysAndTitles } from '../../issues/index.js';
import { requirementKeysAndTitles } from '../../requirements/index.js';
import { workflowFlowsByIds } from '../../workflows/index.js';

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

const uuidsIn = (summary: ChatProposalSummary): string[] => [
  ...new Set(
    [summary.title, ...summary.lines, ...summary.relates]
      .flatMap((text) => text.match(UUID_RE) ?? [])
      .map((id) => id.toLowerCase()),
  ),
];

/** How each uuid the summary names reads to a person, where it names an issue, requirement or design. */
async function namesOf(projectId: string, ids: readonly string[]): Promise<Map<string, string>> {
  const [issues, requirements, designs] = await Promise.all([
    issueKeysAndTitles(projectId, ids),
    requirementKeysAndTitles(projectId, ids),
    workflowFlowsByIds(projectId, ids),
  ]);
  const names = new Map<string, string>();
  // curly quotes: a straight one would read as JSON in a refused press's sentence (`failure.ts`)
  for (const [id, { key, title }] of [...issues, ...requirements])
    names.set(id, `${key} “${title}”`);
  for (const [id, flow] of designs) names.set(id, `“${flow}”`);
  return names;
}

/**
 * The summary with every uuid that names an issue, requirement or design of `projectId` written as a
 * person reads it; a uuid of another project is never looked up, so no card shows its title.
 */
export async function namedRefs(
  projectId: string,
  summary: ChatProposalSummary,
): Promise<ChatProposalSummary> {
  const ids = uuidsIn(summary);
  if (ids.length === 0) return summary;
  const names = await namesOf(projectId, ids);
  if (names.size === 0) return summary;
  const named = (text: string) => text.replace(UUID_RE, (id) => names.get(id.toLowerCase()) ?? id);
  return {
    ...summary,
    title: named(summary.title),
    lines: summary.lines.map(named),
    relates: summary.relates.map(named),
  };
}
