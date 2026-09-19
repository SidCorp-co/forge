/**
 * ISS-1036 — the Google Sheets commands, for every surface that offers them.
 *
 * Authorisation is the CALLER's job: each surface knows its own principal, and
 * nothing here checks membership. What IS here is the resolution the issue's
 * "refusal by name" rule turns on — which binding, which spreadsheet, and which
 * of the four ways a call can have nothing to act on.
 */

import { grantHolds, notGrantedMessage } from '../agent-access.js';
import { getIntegration } from '../registry.js';
import { isPreviousCredentialValid } from '../rotation.js';
import {
  type BindingWithConnection,
  decryptConnectionSecrets,
  effectiveConfig,
  listBindingsForProject,
} from '../store.js';
import {
  appendValues,
  type GoogleClientArgs,
  getSpreadsheet,
  readValues,
  type SheetValues,
  updateValues,
} from './client.js';
import { GoogleApiError, GoogleAuthError, type GoogleConfig, type GoogleSecrets } from './types.js';

export type GoogleCommandCode =
  | 'NO_CONNECTION'
  | 'BINDING_DISABLED'
  | 'NO_SPREADSHEET'
  /** The binding exists and works; nobody granted agents on this project the use of it. */
  | 'NOT_GRANTED'
  | 'ACCOUNT_REJECTED'
  | 'SHEETS_REFUSED'
  | 'MISSING_ARGUMENT';

export class GoogleCommandError extends Error {
  readonly code: GoogleCommandCode;
  constructor(code: GoogleCommandCode, message: string) {
    super(message);
    this.name = 'GoogleCommandError';
    this.code = code;
  }
}

/**
 * The project's usable Google binding.
 *
 * Deliberately NOT `findActiveBinding`: that helper filters on `active` at both
 * tiers, so a binding an operator switched off comes back as the same `null` an
 * absent one does, and the two refusals this issue asks to be told apart cannot
 * be. Widening the shared helper would change what every other provider sees,
 * so the classification is done here instead.
 */
export async function resolveGoogleBinding(projectId: string): Promise<BindingWithConnection> {
  const rows = (await listBindingsForProject(projectId)).filter(
    (r) => r.binding.provider === 'google',
  );
  if (rows.length === 0) {
    throw new GoogleCommandError(
      'NO_CONNECTION',
      'this project has no Google connection bound — add one under Settings → Integrations → Google, or bind an existing org service account to this project.',
    );
  }
  const usable = rows
    .filter((r) => r.binding.active && r.connection.active)
    .sort((a, b) => a.binding.createdAt.getTime() - b.binding.createdAt.getTime());
  const disabledPair = rows[0];
  if (!usable[0]) {
    const which =
      disabledPair && !disabledPair.connection.active
        ? 'its Google credential is switched off for every project sharing it'
        : 'the binding is switched off for this project';
    throw new GoogleCommandError(
      'BINDING_DISABLED',
      `this project's Google connection exists but ${which} — re-enable it under Settings → Integrations → Google. Nothing was sent to Google.`,
    );
  }
  if (!grantHolds(getIntegration('google'), usable[0].binding)) {
    throw new GoogleCommandError('NOT_GRANTED', notGrantedMessage('google', usable[0].binding.id));
  }
  return usable[0];
}

/** Which spreadsheet the caller means: the one it named, else the binding's
 *  declared default, else a refusal — never a guess. */
export function resolveSpreadsheetId(
  pair: BindingWithConnection,
  explicit: string | undefined,
): string {
  if (explicit && explicit.length > 0) return explicit;
  const fallback = (pair.binding.config as GoogleConfig | null)?.defaultSpreadsheetId;
  if (typeof fallback === 'string' && fallback.length > 0) return fallback;
  throw new GoogleCommandError(
    'NO_SPREADSHEET',
    "no spreadsheet was named and this project's Google binding declares no default — pass `spreadsheetId`, or set a default spreadsheet on the binding. Nothing was sent to Google.",
  );
}

function clientArgsFor(pair: BindingWithConnection): GoogleClientArgs {
  const secrets = decryptConnectionSecrets<GoogleSecrets>(pair.connection);
  const serviceAccountJson = secrets.serviceAccountJson;
  if (typeof serviceAccountJson !== 'string' || serviceAccountJson.length === 0) {
    throw new GoogleCommandError(
      'ACCOUNT_REJECTED',
      'the bound Google connection holds no service-account key — re-enter the key file under Settings → Integrations → Google.',
    );
  }
  const previous = secrets.previousServiceAccountJson;
  const carryPrevious =
    typeof previous === 'string' && previous.length > 0 && isPreviousCredentialValid(secrets);
  return {
    connectionId: pair.connection.id,
    serviceAccountJson,
    ...(carryPrevious ? { previousServiceAccountJson: previous } : {}),
  };
}

/**
 * Turn a provider failure into a refusal that names the cause. The two Google
 * error kinds are kept apart on the way out for the same reason they are kept
 * apart on the way in: one says replace the credential, the other says the
 * credential is fine and the sheet is not shared with it.
 */
function rethrowAsCommandError(err: unknown): never {
  if (err instanceof GoogleAuthError && err.kind === 'rejected') {
    throw new GoogleCommandError('ACCOUNT_REJECTED', err.message);
  }
  if (err instanceof GoogleApiError) {
    throw new GoogleCommandError('SHEETS_REFUSED', err.message);
  }
  throw err;
}

/** Resolve binding + spreadsheet + credential in one hop, so every command
 *  raises the same four refusals in the same order, before any request to
 *  Google. */
async function prepare(projectId: string, spreadsheetId: string | undefined) {
  const pair = await resolveGoogleBinding(projectId);
  const resolved = resolveSpreadsheetId(pair, spreadsheetId);
  return { pair, spreadsheetId: resolved, args: clientArgsFor(pair) };
}

export async function listGoogleIntegrations(projectId: string) {
  const rows = (await listBindingsForProject(projectId)).filter(
    (r) => r.binding.provider === 'google',
  );
  return {
    integrations: rows.map((r) => {
      const config = effectiveConfig<GoogleConfig>(r);
      return {
        id: r.binding.id,
        role: r.binding.role,
        stages: r.binding.stages ?? [],
        active: r.binding.active && r.connection.active,
        clientEmail: config.clientEmail ?? null,
        defaultSpreadsheetId: config.defaultSpreadsheetId ?? null,
        lastHealthStatus: r.connection.lastHealthStatus,
      };
    }),
  };
}

export async function googleSheetsInfo(input: { projectId: string; spreadsheetId?: string }) {
  const { args, spreadsheetId } = await prepare(input.projectId, input.spreadsheetId);
  try {
    return await getSpreadsheet(args, spreadsheetId);
  } catch (err) {
    return rethrowAsCommandError(err);
  }
}

export async function googleSheetsRead(input: {
  projectId: string;
  spreadsheetId?: string;
  range: string;
}) {
  const { args, spreadsheetId } = await prepare(input.projectId, input.spreadsheetId);
  try {
    return await readValues(args, spreadsheetId, input.range);
  } catch (err) {
    return rethrowAsCommandError(err);
  }
}

export async function googleSheetsUpdate(input: {
  projectId: string;
  spreadsheetId?: string;
  range: string;
  values: SheetValues;
}) {
  const { args, spreadsheetId } = await prepare(input.projectId, input.spreadsheetId);
  try {
    return await updateValues(args, spreadsheetId, input.range, input.values);
  } catch (err) {
    return rethrowAsCommandError(err);
  }
}

export async function googleSheetsAppend(input: {
  projectId: string;
  spreadsheetId?: string;
  range: string;
  values: SheetValues;
}) {
  const { args, spreadsheetId } = await prepare(input.projectId, input.spreadsheetId);
  try {
    return await appendValues(args, spreadsheetId, input.range, input.values);
  } catch (err) {
    return rethrowAsCommandError(err);
  }
}
