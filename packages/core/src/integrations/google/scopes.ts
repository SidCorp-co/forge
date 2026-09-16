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

export function scopeFor(access: SheetsAccess): string {
  return access === 'write' ? SHEETS_READWRITE_SCOPE : SHEETS_READONLY_SCOPE;
}
