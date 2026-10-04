import {
  type ContentLanguageRecord,
  type ContentLanguageView,
  contentLanguageOf,
} from '@forge/contracts/content-language';
import { mergeSessionMetadata } from '../agent-sessions/index.js';
import { readProjectDocument } from '../project-config/service.js';
import { CONTENT_LANGUAGE_KEY } from './block.js';

/** The project's setting at the document revision read; a project with no document writes `en`. */
export async function readContentLanguage(projectId: string): Promise<ContentLanguageView> {
  const held = await readProjectDocument(projectId);
  return { ...contentLanguageOf(held?.document ?? null), revision: held?.revision ?? null };
}

/** Stamps the language a session was told on its metadata, merged so no other key is touched. */
export async function recordContentLanguage(
  agentSessionId: string,
  record: ContentLanguageRecord,
): Promise<void> {
  await mergeSessionMetadata(agentSessionId, { [CONTENT_LANGUAGE_KEY]: record });
}
