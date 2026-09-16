/**
 * ISS-1036 — the Google scopes Forge asks for, and nothing else.
 *
 * A service account an org shares across projects is asked for the narrowest
 * grant each operation needs, so the blast radius of the shared credential is
 * the operation rather than the account.
 */

/** Reading cells and spreadsheet metadata. */
export const SHEETS_READONLY_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

/** Writing cells. Google publishes no narrower write scope for Sheets. */
export const SHEETS_READWRITE_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

/** Every scope this integration may request. */
export const GOOGLE_SCOPES = [SHEETS_READONLY_SCOPE, SHEETS_READWRITE_SCOPE] as const;

export type SheetsAccess = 'read' | 'write';

// cm:guard never add a `drive` scope here, and never widen a read to the read-write scope to save a second mint. `.../auth/drive` reaches every file the account can see, across every project the org shares it with, to read the one spreadsheet this project bound — which is the blast radius the per-operation split exists to refuse (ISS-1036). A caller needing more asks Google for a wider grant on the account, not Forge for a wider scope on the token.
export function scopeFor(access: SheetsAccess): string {
  return access === 'write' ? SHEETS_READWRITE_SCOPE : SHEETS_READONLY_SCOPE;
}
