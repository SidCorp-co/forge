import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { __resetGoogleTokenCache } from './auth.js';
import { appendValues, getSpreadsheet, readValues, updateValues } from './client.js';
import type { GoogleApiError } from './types.js';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const KEY_FILE = JSON.stringify({
  type: 'service_account',
  private_key: privateKey,
  client_email: 'forge@forge-sheets-1.iam.gserviceaccount.com',
  token_uri: 'https://oauth2.googleapis.com/token',
});

const CONN = 'conn-google-client';
const SHEET = '1AbC_def-GHI';

interface Seen {
  url: string;
  method: string;
  authorization: string | undefined;
  body: unknown;
}

/**
 * A Google that HOLDS the sheet rather than replaying a fixture: a read after a
 * write returns what the write put there, so a test of "write then read" cannot
 * pass with the write omitted.
 */
function fakeGoogle(opts: { sheetsStatus?: number; title?: string } = {}) {
  const seen: Seen[] = [];
  const cells = new Map<string, unknown>();
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const rawBody = typeof init?.body === 'string' ? init.body : undefined;

    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return new Response(
        JSON.stringify({ access_token: 'ya29.tok', expires_in: 3600, token_type: 'Bearer' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    const parsedBody = rawBody?.startsWith('{') ? JSON.parse(rawBody) : rawBody;
    seen.push({
      url,
      method: init?.method ?? 'GET',
      authorization: headers.authorization,
      body: parsedBody,
    });

    if (opts.sheetsStatus && opts.sheetsStatus !== 200) {
      return new Response('{"error":{"message":"nope"}}', { status: opts.sheetsStatus });
    }

    if (url.includes('?fields=properties.title')) {
      return new Response(
        JSON.stringify({
          properties: { title: opts.title ?? 'Roster' },
          sheets: [{ properties: { title: 'Sheet1' } }, { properties: { title: 'Archive' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    const range = decodeURIComponent(url.split('/values/')[1]?.split('?')[0] ?? '').replace(
      ':append',
      '',
    );
    const values = (parsedBody as { values?: unknown[][] } | undefined)?.values;

    if ((init?.method ?? 'GET') === 'PUT') {
      cells.set(range, values);
      return new Response(
        JSON.stringify({ updatedRange: range, updatedCells: (values ?? []).flat().length }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if ((init?.method ?? 'GET') === 'POST') {
      const existing = (cells.get(range) as unknown[][] | undefined) ?? [];
      cells.set(range, [...existing, ...(values ?? [])]);
      return new Response(
        JSON.stringify({
          updates: { updatedRange: range, updatedCells: (values ?? []).flat().length },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ range, values: cells.get(range) ?? [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { seen, impl };
}

function args(impl: typeof fetch) {
  return { connectionId: CONN, serviceAccountJson: KEY_FILE, fetchImpl: impl };
}

afterEach(() => {
  __resetGoogleTokenCache();
});

describe('getSpreadsheet', () => {
  it('asks the Sheets host for the title and tab names of the id it was given', async () => {
    const g = fakeGoogle({ title: 'Q4 roster' });
    const out = await getSpreadsheet(args(g.impl), SHEET);
    expect(out).toEqual({
      spreadsheetId: SHEET,
      title: 'Q4 roster',
      sheetTitles: ['Sheet1', 'Archive'],
    });
    expect(g.seen[0]?.url).toBe(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(SHEET)}?fields=properties.title,sheets.properties.title`,
    );
    expect(g.seen[0]?.method).toBe('GET');
    expect(g.seen[0]?.authorization).toBe('Bearer ya29.tok');
  });
});

describe('readValues (criterion 14)', () => {
  it('requests the named range from the named spreadsheet, url-encoded, as a bearer call', async () => {
    const g = fakeGoogle();
    await readValues(args(g.impl), SHEET, 'Sheet1!A1:C3');
    expect(g.seen).toHaveLength(1);
    expect(g.seen[0]?.url).toBe(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(SHEET)}/values/${encodeURIComponent('Sheet1!A1:C3')}`,
    );
    expect(g.seen[0]?.method).toBe('GET');
    expect(g.seen[0]?.authorization).toBe('Bearer ya29.tok');
  });

  it('an absent values array reads as an empty range rather than undefined', async () => {
    const g = fakeGoogle();
    const out = await readValues(args(g.impl), SHEET, 'Empty!A1:B2');
    expect(out.values).toEqual([]);
  });
});

describe('writing, then reading it back (criterion 15)', () => {
  it('update puts the rows where a following read finds them', async () => {
    const g = fakeGoogle();
    const written = await updateValues(args(g.impl), SHEET, 'Sheet1!A1:B2', [
      ['name', 'count'],
      ['alpha', 3],
    ]);
    expect(written.updatedCells).toBe(4);
    const back = await readValues(args(g.impl), SHEET, 'Sheet1!A1:B2');
    expect(back.values).toEqual([
      ['name', 'count'],
      ['alpha', 3],
    ]);
  });

  it('a read of a range nothing was written to still comes back empty', async () => {
    const g = fakeGoogle();
    await updateValues(args(g.impl), SHEET, 'Sheet1!A1:B1', [['written']]);
    const back = await readValues(args(g.impl), SHEET, 'Other!A1:B1');
    expect(back.values).toEqual([]);
  });

  it('append adds rows after what is already there', async () => {
    const g = fakeGoogle();
    await updateValues(args(g.impl), SHEET, 'Sheet1!A:B', [['first', 1]]);
    await appendValues(args(g.impl), SHEET, 'Sheet1!A:B', [['second', 2]]);
    const back = await readValues(args(g.impl), SHEET, 'Sheet1!A:B');
    expect(back.values).toEqual([
      ['first', 1],
      ['second', 2],
    ]);
  });

  it('a write is a PUT carrying USER_ENTERED, so a date stays a date', async () => {
    const g = fakeGoogle();
    await updateValues(args(g.impl), SHEET, 'Sheet1!A1', [['2026-09-16']]);
    expect(g.seen[0]?.method).toBe('PUT');
    expect(g.seen[0]?.url).toContain('valueInputOption=USER_ENTERED');
    expect(g.seen[0]?.body).toMatchObject({ majorDimension: 'ROWS', values: [['2026-09-16']] });
  });

  it('append is a POST to the :append route and inserts rows', async () => {
    const g = fakeGoogle();
    await appendValues(args(g.impl), SHEET, 'Sheet1!A:B', [['x', 1]]);
    expect(g.seen[0]?.method).toBe('POST');
    expect(g.seen[0]?.url).toContain(':append');
    expect(g.seen[0]?.url).toContain('insertDataOption=INSERT_ROWS');
  });
});

describe('what Google refusing a sheet looks like', () => {
  it('403 names the sharing that is missing and stays needs_scope-shaped', async () => {
    const g = fakeGoogle({ sheetsStatus: 403 });
    await expect(readValues(args(g.impl), SHEET, 'A1')).rejects.toMatchObject({ status: 403 });
    await readValues(args(g.impl), SHEET, 'A1').catch((err: GoogleApiError) => {
      expect(err.message).toContain('share the sheet');
      expect(err.message).toContain(SHEET);
    });
  });

  it('401 is a rejected token, which is a different sentence from 403', async () => {
    const g = fakeGoogle({ sheetsStatus: 401 });
    await readValues(args(g.impl), SHEET, 'A1').catch((err: GoogleApiError) => {
      expect(err.status).toBe(401);
      expect(err.message).not.toContain('share the sheet');
    });
  });

  it('404 names the id rather than reporting an empty sheet', async () => {
    const g = fakeGoogle({ sheetsStatus: 404 });
    await readValues(args(g.impl), SHEET, 'A1').catch((err: GoogleApiError) => {
      expect(err.status).toBe(404);
      expect(err.message).toContain(SHEET);
    });
  });

  it('nothing Google said is echoed back', async () => {
    const g = fakeGoogle({ sheetsStatus: 500 });
    await readValues(args(g.impl), SHEET, 'A1').catch((err: GoogleApiError) => {
      expect(err.message).not.toContain('nope');
      expect(err.message).toContain('HTTP 500');
    });
  });
});

/**
 * A Google whose token endpoint accepts exactly one account. Everything else is
 * refused 400 `invalid_grant`, which is what Google answers for a key it has
 * revoked or has not propagated yet.
 */
function googleAcceptingOnly(accepted: string) {
  const issuers: string[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      const body = new URLSearchParams(String(init?.body));
      const claims = JSON.parse(
        Buffer.from(String(body.get('assertion')).split('.')[1] ?? '', 'base64url').toString(
          'utf8',
        ),
      ) as { iss: string };
      issuers.push(claims.iss);
      if (claims.iss !== accepted) {
        return new Response('{"error":"invalid_grant"}', { status: 400 });
      }
      return new Response(
        JSON.stringify({ access_token: `ya29.${claims.iss}`, expires_in: 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ range: 'A1', values: [['ok']] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { impl, issuers };
}

function keyFileFor(email: string): string {
  return JSON.stringify({
    type: 'service_account',
    private_key: privateKey,
    client_email: email,
    token_uri: 'https://oauth2.googleapis.com/token',
  });
}

const NEW_ACCOUNT = 'new@forge-sheets-1.iam.gserviceaccount.com';
const OLD_ACCOUNT = 'old@forge-sheets-1.iam.gserviceaccount.com';

describe('the rotation window reaches the agent surface, not only the health card', () => {
  afterEach(() => {
    __resetGoogleTokenCache();
  });

  it('a rejected new key falls back once to the retained one and the call completes', async () => {
    const g = googleAcceptingOnly(OLD_ACCOUNT);
    const out = await readValues(
      {
        connectionId: 'conn-rotating',
        serviceAccountJson: keyFileFor(NEW_ACCOUNT),
        previousServiceAccountJson: keyFileFor(OLD_ACCOUNT),
        fetchImpl: g.impl,
      },
      SHEET,
      'A1',
    );
    expect(out.values).toEqual([['ok']]);
    expect(g.issuers).toEqual([NEW_ACCOUNT, OLD_ACCOUNT]);
  });

  it('with no retained key the rejection is the answer, and it is not retried', async () => {
    const g = googleAcceptingOnly(OLD_ACCOUNT);
    await expect(
      readValues(
        {
          connectionId: 'conn-rotating-2',
          serviceAccountJson: keyFileFor(NEW_ACCOUNT),
          fetchImpl: g.impl,
        },
        SHEET,
        'A1',
      ),
    ).rejects.toThrow();
    expect(g.issuers).toEqual([NEW_ACCOUNT]);
  });

  it('a retained key Google also refuses is not retried a third time', async () => {
    const g = googleAcceptingOnly('nobody@forge-sheets-1.iam.gserviceaccount.com');
    await expect(
      readValues(
        {
          connectionId: 'conn-rotating-3',
          serviceAccountJson: keyFileFor(NEW_ACCOUNT),
          previousServiceAccountJson: keyFileFor(OLD_ACCOUNT),
          fetchImpl: g.impl,
        },
        SHEET,
        'A1',
      ),
    ).rejects.toThrow();
    expect(g.issuers).toEqual([NEW_ACCOUNT, OLD_ACCOUNT]);
  });
});
