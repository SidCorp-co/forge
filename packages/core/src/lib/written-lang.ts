import type { ActorAgency } from '@forge/contracts/permissions';
import {
  type WrittenLang,
  writtenLangOfTag,
  writtenLangOfText,
} from '@forge/contracts/written-lang';
import { eq } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { userPreferences } from '../db/schema.js';
import { portSlot } from './port-slot.js';

/** What the written language needs from the project-config domain, which the platform may not import. */
interface WrittenLangPorts {
  /** The language a project writes its prose in, as its document names it. */
  contentLanguageOf(projectId: string): Promise<string>;
}

const slot = portSlot<WrittenLangPorts>('written language', 'provideWrittenLangPorts');
/** The process entry hands over the project's content language at boot (`provideProjectOrg` is the pattern). */
export const provideWrittenLangPorts = slot.provide;

/** Who wrote a text, as far as its language goes: a person's own account, or an agent. */
export interface Writer {
  userId: string | null;
  agency: ActorAgency | null;
}

/**
 * The language a text being written now is stored with: what the writer declared (validated as
 * `writtenLangSchema` where it arrived); else what the text's own letters settle
 * (`writtenLangOfText`: an agent told to write Vietnamese that wrote English prose is stored as
 * English, which is what a reader meets); else a person's own interface language, else the
 * project's content language, the one agents are told to write prose in. Null where none of these
 * names a language the list holds: an unknown language is stored as unknown, never guessed.
 */
export async function writtenLangFor(
  writer: Writer,
  projectId: string,
  declared?: WrittenLang | null,
  tx: Tx = db,
  text?: string | null,
): Promise<WrittenLang | null> {
  if (declared) return declared;
  const seen = writtenLangOfText(text);
  if (seen) return seen;
  if (writer.agency !== 'agent' && writer.userId) {
    const [pref] = await tx
      .select({ language: userPreferences.language })
      .from(userPreferences)
      .where(eq(userPreferences.userId, writer.userId))
      .limit(1);
    const own = writtenLangOfTag(pref?.language);
    if (own) return own;
  }
  return writtenLangOfTag(await slot.port('contentLanguageOf')(projectId));
}
