export const SHEETS_READONLY_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

export const SHEETS_READWRITE_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

/** Every scope this integration may request. */
export const GOOGLE_SCOPES = [SHEETS_READONLY_SCOPE, SHEETS_READWRITE_SCOPE] as const;

export type SheetsAccess = 'read' | 'write';

export function scopeFor(access: SheetsAccess): string {
  return access === 'write' ? SHEETS_READWRITE_SCOPE : SHEETS_READONLY_SCOPE;
}
