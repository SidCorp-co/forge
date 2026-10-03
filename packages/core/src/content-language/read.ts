import {
  type ContentLanguageRecord,
  type ContentLanguageView,
  contentLanguageOf,
} from '@forge/contracts/content-language';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions } from '../db/schema.js';
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
  const patch = { [CONTENT_LANGUAGE_KEY]: record };
  await db
    .update(agentSessions)
    .set({
      metadata: sql`coalesce(${agentSessions.metadata}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
    })
    .where(eq(agentSessions.id, agentSessionId));
}
