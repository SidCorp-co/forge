import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakePrincipal } from '../fake-principal.fixture.js';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));

const resultQueue: unknown[] = [];
// biome-ignore lint/suspicious/noExplicitAny: minimal chainable drizzle stub
function makeThenable(): any {
  // biome-ignore lint/suspicious/noExplicitAny: see above
  const p: any = {
    from: () => p,
    innerJoin: () => p,
    leftJoin: () => p,
    where: () => p,
    orderBy: () => p,
    limit: () => p,
    then: (resolve: (v: unknown) => void) => resolve(resultQueue.shift() ?? []),
  };
  return p;
}

vi.mock('../../db/client.js', () => ({
  db: { select: vi.fn(() => makeThenable()) },
}));

const listSpy = vi.fn();
const infoSpy = vi.fn();
const readSpy = vi.fn();
const updateSpy = vi.fn();
const appendSpy = vi.fn();
vi.mock('../../integrations/google/commands.js', async () => {
  class GoogleCommandError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = 'GoogleCommandError';
      this.code = code;
    }
  }
  return {
    GoogleCommandError,
    listGoogleIntegrations: (...a: unknown[]) => listSpy(...(a as [])),
    googleSheetsInfo: (...a: unknown[]) => infoSpy(...(a as [])),
    googleSheetsRead: (...a: unknown[]) => readSpy(...(a as [])),
    googleSheetsUpdate: (...a: unknown[]) => updateSpy(...(a as [])),
    googleSheetsAppend: (...a: unknown[]) => appendSpy(...(a as [])),
  };
});

const { forgeGoogleSheetsTool } = await import('./forge-google-sheets.js');
const { GoogleCommandError } = await import('../../integrations/google/commands.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '44444444-4444-4444-8444-444444444444';
const DEVICE_ID = '55555555-5555-4555-8555-555555555555';
const SHEET = '1SheetId';

const fakePrincipal = makeFakePrincipal(DEVICE_ID, OWNER_ID);

function tool() {
  return forgeGoogleSheetsTool({ principal: fakePrincipal, projectSlug: null });
}

function pushMemberOk() {
  resultQueue.push([{ orgId: 'org-1', memberRole: 'member', orgRole: null }]);
}

function pushAdminOk() {
  resultQueue.push([{ orgId: 'org-1', memberRole: 'admin', orgRole: null }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  resultQueue.length = 0;
});

describe('forge_google_sheets routing', () => {
  it("list reaches the project's bindings", async () => {
    pushMemberOk();
    listSpy.mockResolvedValue({ integrations: [] });
    await tool().handler({ action: 'list', projectId: PROJECT_ID });
    expect(listSpy).toHaveBeenCalledWith(PROJECT_ID);
  });

  it('read passes the range and lets the spreadsheet stay unnamed', async () => {
    pushMemberOk();
    readSpy.mockResolvedValue({ values: [] });
    await tool().handler({ action: 'read', projectId: PROJECT_ID, range: 'Sheet1!A1:B2' });
    expect(readSpy).toHaveBeenCalledWith({ projectId: PROJECT_ID, range: 'Sheet1!A1:B2' });
  });

  it('read passes an explicit spreadsheet through when one is named', async () => {
    pushMemberOk();
    readSpy.mockResolvedValue({ values: [] });
    await tool().handler({
      action: 'read',
      projectId: PROJECT_ID,
      spreadsheetId: SHEET,
      range: 'A1',
    });
    expect(readSpy).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      spreadsheetId: SHEET,
      range: 'A1',
    });
  });

  it('update carries the rows', async () => {
    pushAdminOk();
    updateSpy.mockResolvedValue({ updatedCells: 2 });
    await tool().handler({
      action: 'update',
      projectId: PROJECT_ID,
      range: 'Sheet1!A1:B1',
      values: [['a', 1]],
    });
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ range: 'Sheet1!A1:B1', values: [['a', 1]] }),
    );
  });

  it('append reaches the append command, not update', async () => {
    pushAdminOk();
    appendSpy.mockResolvedValue({ updatedCells: 1 });
    await tool().handler({
      action: 'append',
      projectId: PROJECT_ID,
      range: 'Sheet1!A:B',
      values: [['a']],
    });
    expect(appendSpy).toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('info needs no range', async () => {
    pushMemberOk();
    infoSpy.mockResolvedValue({ title: 'Roster' });
    await expect(tool().handler({ action: 'info', projectId: PROJECT_ID })).resolves.toMatchObject({
      title: 'Roster',
    });
  });
});

describe('forge_google_sheets refusals', () => {
  it('turns a command refusal into the MCP `CODE: message` contract, unchanged', async () => {
    pushMemberOk();
    readSpy.mockRejectedValue(
      new GoogleCommandError(
        'NO_CONNECTION',
        'this project has no Google connection bound — add one.',
      ),
    );
    await expect(
      tool().handler({ action: 'read', projectId: PROJECT_ID, range: 'A1' }),
    ).rejects.toThrow('BAD_REQUEST: this project has no Google connection bound — add one.');
  });

  it('refuses a read with no range rather than guessing one', async () => {
    pushMemberOk();
    await expect(tool().handler({ action: 'read', projectId: PROJECT_ID })).rejects.toThrow(
      /needs `range`/,
    );
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('refuses a write with no values rather than clearing the range', async () => {
    pushAdminOk();
    await expect(
      tool().handler({ action: 'update', projectId: PROJECT_ID, range: 'A1' }),
    ).rejects.toThrow(/needs `values`/);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('refuses an unknown action at the schema, before any project is resolved', async () => {
    await expect(tool().handler({ action: 'delete', projectId: PROJECT_ID })).rejects.toThrow();
  });

  it('refuses a key an operator hoped to pass through', async () => {
    await expect(
      tool().handler({ action: 'list', projectId: PROJECT_ID, serviceAccountJson: 'x' }),
    ).rejects.toThrow();
  });
});

describe('what the tool tells a model', () => {
  it('states that the credential is held by core and never returned', () => {
    const description = tool().description;
    expect(description).toContain('SERVICE ACCOUNT');
    expect(description).toContain('never by you');
  });

  it('states the sharing rule, which is the failure an operator actually hits', () => {
    expect(tool().description).toContain('SHARED with the account');
  });

  it('states that update overwrites and append adds', () => {
    expect(tool().description).toContain('OVERWRITES');
    expect(tool().description).toContain('AFTER the last non-empty row');
  });

  it('states that a call with no sheet resolved is refused rather than guessed', () => {
    expect(tool().description).toContain('no sheet is guessed');
  });
});
