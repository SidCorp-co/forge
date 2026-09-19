import { describe, expect, it } from 'vitest';
import { __resetGoogleTokenCache, googleAccessToken } from './auth.js';
import { getSpreadsheet } from './client.js';
import { SHEETS_READONLY_SCOPE } from './scopes.js';

const serviceAccountJson = process.env.GOOGLE_TEST_SERVICE_ACCOUNT_JSON;
const spreadsheetId = process.env.GOOGLE_TEST_SPREADSHEET_ID;
const haveCredential = Boolean(serviceAccountJson && spreadsheetId);

describe.skipIf(!haveCredential)('against Google itself (criterion 10, live half)', () => {
  it('mints an access token Google issued', async () => {
    __resetGoogleTokenCache();
    const minted = await googleAccessToken({
      connectionId: 'live-test',
      serviceAccountJson: String(serviceAccountJson),
      scope: SHEETS_READONLY_SCOPE,
      forceMint: true,
    });
    expect(minted.token.length).toBeGreaterThan(20);
    expect(minted.expiresAt).toBeGreaterThan(Date.now());
  }, 30_000);

  it('reads the real spreadsheet with it', async () => {
    const sheet = await getSpreadsheet(
      { connectionId: 'live-test', serviceAccountJson: String(serviceAccountJson) },
      String(spreadsheetId),
    );
    expect(sheet.spreadsheetId).toBe(spreadsheetId);
    expect(typeof sheet.title).toBe('string');
    expect(sheet.sheetTitles.length).toBeGreaterThan(0);
  }, 30_000);
});

describe.skipIf(haveCredential)('against Google itself — NOT RUN', () => {
  it('reports criterion 10 LIVE HALF UNPROVED — no Google credential in this environment', () => {
    expect(haveCredential).toBe(false);
    console.warn(
      'ISS-1036 criterion 10 LIVE HALF UNPROVED: GOOGLE_TEST_SERVICE_ACCOUNT_JSON and GOOGLE_TEST_SPREADSHEET_ID are not set, so nothing in this run proves Google accepts the assertion Forge builds. Everything else about the Google provider is proved against a recorded boundary.',
    );
  });
});
