/**
 * ISS-1036 — the Sheets v4 calls Forge makes on a project's behalf.
 *
 * Every call mints its own narrow token (`scopes.ts`) and carries it as a
 * bearer. Nothing here returns Google's raw body to a caller: a third party's
 * response has carried tokens and internal identifiers, so a failure is a
 * status plus a sentence Forge wrote.
 */

import { googleAccessToken } from './auth.js';
import { type SheetsAccess, scopeFor } from './scopes.js';
import { GoogleApiError } from './types.js';

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const CALL_TIMEOUT_MS = 20_000;

/** The value shape both directions of the values API use. */
export type SheetValues = (string | number | boolean | null)[][];

export interface SpreadsheetIdentity {
  spreadsheetId: string;
  title: string | null;
  sheetTitles: string[];
}

export interface ValuesRange {
  spreadsheetId: string;
  range: string;
  values: SheetValues;
}

export interface WriteResult {
  spreadsheetId: string;
  range: string;
  updatedCells: number;
}

export interface GoogleClientArgs {
  connectionId: string;
  serviceAccountJson: string;
  fetchImpl?: typeof fetch;
}

// cm:guard 401 and 403 are different verdicts and must never be collapsed — Google answers 401 for a token it will not accept and 403 for an account it accepts and refuses this spreadsheet, and the two name different operator actions: replace the credential, or share the sheet with the account. The same guard is on `coolify/adapter.ts` and `github/adapter.ts` (ISS-924).
function describeSheetsFailure(status: number, route: string, spreadsheetId: string): GoogleApiError {
  if (status === 401) {
    return new GoogleApiError(
      401,
      route,
      'Google rejected the access token Forge had just minted — the service account was disabled or its key revoked mid-call.',
    );
  }
  if (status === 403) {
    return new GoogleApiError(
      403,
      route,
      `the service account is valid but is not allowed to reach spreadsheet ${spreadsheetId} — share the sheet with the account's client_email, at Viewer for reads and Editor for writes.`,
    );
  }
  if (status === 404) {
    return new GoogleApiError(
      404,
      route,
      `Google has no spreadsheet ${spreadsheetId} — check the id, which is the segment between /d/ and /edit in the sheet's URL.`,
    );
  }
  return new GoogleApiError(status, route, `the Google Sheets API answered HTTP ${status}`);
}

/** One authenticated Sheets call. The scope is the operation's, not the
 *  connection's, so a read never carries a token that could write. */
async function call<T>(
  args: GoogleClientArgs,
  access: SheetsAccess,
  route: string,
  spreadsheetId: string,
  init: RequestInit,
): Promise<T> {
  const { token } = await googleAccessToken({
    connectionId: args.connectionId,
    serviceAccountJson: args.serviceAccountJson,
    scope: scopeFor(access),
    ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
  });
  const doFetch = args.fetchImpl ?? fetch;
  const res = await doFetch(route, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      authorization: `Bearer ${token}`,
      accept: 'application/json',
    },
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (!res.ok) throw describeSheetsFailure(res.status, route, spreadsheetId);
  return (await res.json()) as T;
}

interface SpreadsheetBody {
  properties?: { title?: string };
  sheets?: { properties?: { title?: string } }[];
}

/** Title + tab names. This is what test-connection reads with the token it
 *  just minted, so a green card means Google really answered. */
export async function getSpreadsheet(
  args: GoogleClientArgs,
  spreadsheetId: string,
): Promise<SpreadsheetIdentity> {
  const route = `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}?fields=properties.title,sheets.properties.title`;
  const body = await call<SpreadsheetBody>(args, 'read', route, spreadsheetId, { method: 'GET' });
  return {
    spreadsheetId,
    title: body.properties?.title ?? null,
    sheetTitles: (body.sheets ?? [])
      .map((s) => s.properties?.title)
      .filter((t): t is string => typeof t === 'string'),
  };
}

export async function readValues(
  args: GoogleClientArgs,
  spreadsheetId: string,
  range: string,
): Promise<ValuesRange> {
  const route = `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`;
  const body = await call<{ range?: string; values?: SheetValues }>(
    args,
    'read',
    route,
    spreadsheetId,
    { method: 'GET' },
  );
  return { spreadsheetId, range: body.range ?? range, values: body.values ?? [] };
}

// cm:why USER_ENTERED, not RAW — an operator maintaining a roster by hand expects `2026-09-16` to land as a date and `=SUM(...)` as a formula, which is what the same value typed into the cell would do. RAW would store both as text and the sheet would silently stop computing.
const VALUE_INPUT_OPTION = 'USER_ENTERED';

export async function updateValues(
  args: GoogleClientArgs,
  spreadsheetId: string,
  range: string,
  values: SheetValues,
): Promise<WriteResult> {
  const route = `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=${VALUE_INPUT_OPTION}`;
  const body = await call<{ updatedRange?: string; updatedCells?: number }>(
    args,
    'write',
    route,
    spreadsheetId,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ range, majorDimension: 'ROWS', values }),
    },
  );
  return {
    spreadsheetId,
    range: body.updatedRange ?? range,
    updatedCells: body.updatedCells ?? 0,
  };
}

export async function appendValues(
  args: GoogleClientArgs,
  spreadsheetId: string,
  range: string,
  values: SheetValues,
): Promise<WriteResult> {
  const route = `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append?valueInputOption=${VALUE_INPUT_OPTION}&insertDataOption=INSERT_ROWS`;
  const body = await call<{ updates?: { updatedRange?: string; updatedCells?: number } }>(
    args,
    'write',
    route,
    spreadsheetId,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ range, majorDimension: 'ROWS', values }),
    },
  );
  return {
    spreadsheetId,
    range: body.updates?.updatedRange ?? range,
    updatedCells: body.updates?.updatedCells ?? 0,
  };
}
