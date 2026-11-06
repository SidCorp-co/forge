// A held write's text against the project's content language (REQ-69 BC-10): the chat replies in the
// person's language, and what it saves for the project is in the project's. A held call carrying
// prose plainly in another language is refused before its card is offered, naming the field, so the
// model rewrites it in the same turn rather than the person recording text the project cannot read.
// The person's own reply preferences are theirs, not the project's, and are not read.

import type { ChatProposalKind } from '@forge/contracts/chat-proposals';
import { contentLanguageMisfit, contentLanguageName } from '@forge/contracts/content-language';
import type { CallToolResult } from '../../lib/tool-result.js';
import { readContentLanguage } from '../../project-config/index.js';
import { toolError } from '../tools/mcp-adapter.js';

const NOT_PROJECT_TEXT: ReadonlySet<ChatProposalKind> = new Set(['preferences']);
const MAX_DEPTH = 6;

/** Every string the arguments carry, with the path it sits at. */
function stringsOf(value: unknown, path: string, depth: number, out: [string, string][]): void {
  if (depth > MAX_DEPTH) return;
  if (typeof value === 'string') {
    out.push([path || '(arguments)', value]);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const entries = Array.isArray(value)
    ? value.map((v, i) => [`${path}[${i}]`, v] as const)
    : Object.entries(value).map(([k, v]) => [path ? `${path}.${k}` : k, v] as const);
  for (const [at, v] of entries) stringsOf(v, at, depth + 1, out);
}

/** The refusal of a held call whose text is not in the project's language, or null. */
export async function heldLanguageRefusal(
  projectId: string,
  kind: ChatProposalKind,
  name: string,
  argsJson: string,
): Promise<CallToolResult | null> {
  if (NOT_PROJECT_TEXT.has(kind)) return null;
  let args: unknown;
  try {
    args = argsJson.trim() ? JSON.parse(argsJson) : {};
  } catch {
    return null;
  }
  const strings: [string, string][] = [];
  stringsOf(args, '', 0, strings);
  if (strings.length === 0) return null;
  const { contentLanguage: tag } = await readContentLanguage(projectId);
  for (const [path, text] of strings) {
    const misfit = contentLanguageMisfit(tag, text);
    if (!misfit) continue;
    return toolError(
      `CHAT_TEXT_NOT_IN_PROJECT_LANGUAGE: ${path} would be saved for this project, but ${misfit}. Nothing was held and no card was offered. Write it in ${contentLanguageName(tag)}, keeping the person's meaning, and call ${name} again; your reply to them stays in their language.`,
    );
  }
  return null;
}
