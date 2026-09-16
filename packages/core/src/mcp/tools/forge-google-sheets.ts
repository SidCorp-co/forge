/**
 * ISS-1036 — `forge_google_sheets`, the way an agent reaches a Google Sheet.
 *
 * The point of the tool is what it does NOT hand back: the project's service
 * account is resolved server-side and the Google call is made from core, so no
 * session, prompt or MCP server config ever holds the key. Same shape as
 * `forge-coolify-deploy.ts`, for the same reason.
 *
 * The action list and what each one returns live in the `description` below —
 * it is what a model actually reads, and a second copy here is one that goes
 * stale.
 *
 * Authorization is membership-level like `forge_issues`, raised to writer for
 * the two actions that change a sheet. No DEVICE_REQUIRED entry — the tool has
 * no runner dependency.
 */

import { z } from 'zod';
import {
  GoogleCommandError,
  googleSheetsAppend,
  googleSheetsInfo,
  googleSheetsRead,
  googleSheetsUpdate,
  listGoogleIntegrations,
} from '../../integrations/google/commands.js';
import {
  assertPrincipalIsMember,
  assertPrincipalIsWriter,
  type ContextScopedMcpToolFactory,
  type McpContext,
  resolveEffectiveProjectId,
  zodToMcpSchema,
} from './lib.js';

const cellSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const inputSchema = z
  .object({
    action: z.enum(['list', 'info', 'read', 'update', 'append']),
    projectId: z.uuid().optional(),
    /** The spreadsheet id — the segment between `/d/` and `/edit` in its URL.
     *  Omitted = the project binding's declared default. */
    spreadsheetId: z.string().min(1).max(200).optional(),
    /** A1 notation, e.g. `Sheet1!A1:D50` or a whole tab name. */
    range: z.string().min(1).max(500).optional(),
    /** Rows of cells, for update and append. */
    values: z.array(z.array(cellSchema)).max(5000).optional(),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export const forgeGoogleSheetsTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_google_sheets',
  description:
    'Read and write the Google Sheets this project\'s service account is granted. Actions: list | ' +
    'info | read | update | append. ' +
    'MODEL: the credential is a Google SERVICE ACCOUNT held by Forge, never by you — core resolves ' +
    "the project's binding and makes the Google call itself, so there is no key to fetch and none " +
    'is returned. A sheet is reachable only if it has been SHARED with the account\'s client_email ' +
    '(Viewer for reads, Editor for writes); `info` is how you find out. ' +
    'spreadsheetId is the segment between /d/ and /edit in the sheet URL, and is OPTIONAL: omitted, ' +
    "it resolves to the spreadsheet this project's binding declares as its default. Naming one " +
    'overrides that default for the call. If neither is present the call is REFUSED — no sheet is ' +
    'guessed. ' +
    'list: the project\'s Google bindings — { id, environment, active, clientEmail, ' +
    'defaultSpreadsheetId, lastHealthStatus }. An empty array means this project has no Google ' +
    'connection; that is the answer, not an error. ' +
    'info: { spreadsheetId, title, sheetTitles[] } — read this BEFORE a range, because a range ' +
    'naming a tab that does not exist is refused by Google rather than returning empty. ' +
    'read: { spreadsheetId, range, values[][] } for a range in A1 notation (`Sheet1!A1:D50`, or a ' +
    'bare tab name for everything in it). Trailing empty cells are not padded — a short row is a ' +
    'short array. ' +
    'update: OVERWRITES the cells of `range` with `values` and returns { spreadsheetId, range, ' +
    'updatedCells }. It does not insert rows: writing 3 rows over a 10-row range leaves rows 4-10 ' +
    'as they were. To add rows without disturbing anything, use append. ' +
    'append: adds `values` as new rows AFTER the last non-empty row of the table `range` names, and ' +
    'returns the range it actually wrote. ' +
    'Values are entered as a person typing them would be: `2026-09-16` lands as a date and ' +
    '`=SUM(A1:A9)` as a formula. ' +
    'Scopes are per operation: read and info mint a READ-ONLY Google token, update and append mint ' +
    'a read-write one, and nothing ever asks for Drive access. ' +
    'Refusals name their cause and nothing is half-done: no Google connection on this project, the ' +
    'binding switched off, no spreadsheet named and no default declared, Google rejecting the ' +
    'service account, and Google refusing the sheet (share it with client_email) are five different ' +
    'messages. A call that could not act does not return an empty success. ' +
    'Project scope comes from the X-Forge-Project-Slug header (or an explicit projectId). ' +
    'Authorization: project membership; update and append need writer.',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    try {
      return await dispatchAction(input, ctx);
    } catch (err) {
      // cm:edge contract -> packages/core/src/integrations/google/commands.ts — that module throws `GoogleCommandError` with a bare sentence so a REST surface can turn it into a 400 body; the MCP contract is a `CODE: message` string, so the prefix is added HERE and must not be baked into the shared message.
      if (err instanceof GoogleCommandError) throw new Error(`BAD_REQUEST: ${err.message}`);
      throw err;
    }
  },
});

/** The range every write needs. Refused by name rather than defaulted: a
 *  guessed range is a write to cells nobody asked about. */
function requireRange(input: Input, action: string): string {
  if (!input.range) {
    throw new GoogleCommandError(
      'MISSING_ARGUMENT',
      `${action} needs \`range\` in A1 notation — e.g. "Sheet1!A1:D50". Call info to see the tab names.`,
    );
  }
  return input.range;
}

function requireValues(input: Input, action: string): NonNullable<Input['values']> {
  if (!input.values || input.values.length === 0) {
    throw new GoogleCommandError(
      'MISSING_ARGUMENT',
      `${action} needs \`values\` — an array of rows, each an array of cells.`,
    );
  }
  return input.values;
}

async function dispatchAction(input: Input, ctx: McpContext): Promise<unknown> {
  const projectId = await resolveEffectiveProjectId(ctx, input.projectId);
  const { principal } = ctx;
  const spreadsheet = input.spreadsheetId ? { spreadsheetId: input.spreadsheetId } : {};

  switch (input.action) {
    case 'list': {
      await assertPrincipalIsMember(principal, projectId);
      return listGoogleIntegrations(projectId);
    }
    case 'info': {
      await assertPrincipalIsMember(principal, projectId);
      return googleSheetsInfo({ projectId, ...spreadsheet });
    }
    case 'read': {
      await assertPrincipalIsMember(principal, projectId);
      return googleSheetsRead({ projectId, ...spreadsheet, range: requireRange(input, 'read') });
    }
    case 'update': {
      await assertPrincipalIsWriter(principal, projectId);
      return googleSheetsUpdate({
        projectId,
        ...spreadsheet,
        range: requireRange(input, 'update'),
        values: requireValues(input, 'update'),
      });
    }
    case 'append': {
      await assertPrincipalIsWriter(principal, projectId);
      return googleSheetsAppend({
        projectId,
        ...spreadsheet,
        range: requireRange(input, 'append'),
        values: requireValues(input, 'append'),
      });
    }
  }
}
