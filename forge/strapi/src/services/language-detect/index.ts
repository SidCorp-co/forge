/**
 * Detect and persist user's preferred output language.
 *
 * Storage: `user-preference` record keyed by userKey (persistent DB field).
 * Never lost — not in memory system, not in session metadata.
 *
 * Flow:
 * 1. Load stored preferredLanguage from user-preference → use it
 * 2. If none stored, detect from current message text
 * 3. On first detection, save to user-preference (permanent)
 * 4. Only overwritten when user explicitly asks to change
 */

const PREF_UID = 'api::user-preference.user-preference';

// Vietnamese diacritical characters
const VI_PATTERN = /[\u00C0-\u00C3\u00C8-\u00CA\u00CC-\u00CD\u00D2-\u00D5\u00D9-\u00DA\u00DD\u00E0-\u00E3\u00E8-\u00EA\u00EC-\u00ED\u00F2-\u00F5\u00F9-\u00FA\u00FD\u0102\u0103\u0110\u0111\u0128\u0129\u0168\u0169\u01A0\u01A1\u01AF\u01B0\u1EA0-\u1EF9]/;
const CJK_PATTERN = /[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/;
const CYRILLIC_PATTERN = /[\u0400-\u04FF]/;
const THAI_PATTERN = /[\u0E00-\u0E7F]/;

function detectFromText(text: string): string | null {
  const viMatches = (text.match(new RegExp(VI_PATTERN.source, 'g')) || []).length;
  if (viMatches >= 2) return 'Vietnamese';
  if (CJK_PATTERN.test(text)) {
    if (/[\u3040-\u309F\u30A0-\u30FF]/.test(text)) return 'Japanese';
    if (/[\uAC00-\uD7AF]/.test(text)) return 'Korean';
    return 'Chinese';
  }
  if (CYRILLIC_PATTERN.test(text)) return 'Russian';
  if (THAI_PATTERN.test(text)) return 'Thai';
  return null;
}

/**
 * Get or create user-preference record.
 */
async function getOrCreatePref(strapi: any, userKey: string, projectDocId: string): Promise<any> {
  const docs = strapi.documents(PREF_UID);
  const existing = await docs.findMany({
    filters: { userKey: { $eq: userKey } },
    limit: 1,
  });
  if (existing.length > 0) return existing[0];

  return docs.create({
    data: { userKey, project: { documentId: projectDocId } },
  });
}

/**
 * Resolve the user's preferred output language.
 *
 * - Returns stored preference from user-preference record (permanent)
 * - If not stored, detects from message and saves permanently
 * - Returns null for English (default, no instruction needed)
 */
export async function resolvePreferredLanguage(
  strapi: any,
  projectDocId: string,
  userKey: string,
  message: string,
): Promise<string | null> {
  try {
    const pref = await getOrCreatePref(strapi, userKey, projectDocId);

    // 1. Stored preference → use it
    if (pref.preferredLanguage) return pref.preferredLanguage;

    // 2. Detect from current message
    const detected = detectFromText(message);
    if (!detected) return null;

    // 3. Save permanently (fire-and-forget)
    strapi.log.info(`[language] detected "${detected}" for ${userKey} — saving to user-preference`);
    strapi.documents(PREF_UID).update({
      documentId: pref.documentId,
      data: { preferredLanguage: detected },
    }).catch((err: any) => strapi.log.warn(`[language] save failed: ${err.message}`));

    return detected;
  } catch (err: any) {
    strapi.log.warn(`[language] resolve failed: ${err.message}`);
    return detectFromText(message);
  }
}

/**
 * Explicitly set the user's preferred language (called by agent tool).
 */
export async function setPreferredLanguage(
  strapi: any,
  projectDocId: string,
  userKey: string,
  language: string | null,
): Promise<void> {
  const pref = await getOrCreatePref(strapi, userKey, projectDocId);
  await strapi.documents(PREF_UID).update({
    documentId: pref.documentId,
    data: { preferredLanguage: language },
  });
  strapi.log.info(`[language] set "${language}" for ${userKey}`);
}
