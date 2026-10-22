import { z } from 'zod';

export const testingUrlSchema = z
  .object({
    label: z.string().trim().min(1).max(80),
    url: z.string().trim().url().max(500),
  })
  .catchall(z.unknown());

export const testCredentialSchema = z
  .object({
    label: z.string().trim().min(1).max(80),
    username: z.string().trim().max(200),
    password: z.string().max(500),
  })
  .catchall(z.unknown());

/** Why a written credential is refused: no password to log in with, or a second row for a label or login already listed. */
export type CredentialRule = 'password-required' | 'duplicate-label' | 'duplicate-login';

export interface CredentialFault {
  index: number;
  field: 'label' | 'username' | 'password';
  rule: CredentialRule;
  /** The earlier row a repeat repeats. */
  sameAs?: number;
  /** The document path of the field at fault, e.g. `testCredentials.1.password`. */
  path: string;
  message: string;
}

const text = (value: unknown) => (typeof value === 'string' ? value : '');

/**
 * The credential rows a write may not store: core's copy of `@forge/contracts/test-credentials`
 * `findCredentialFaults`, which core cannot import at runtime; `test-credentials-parity.test.ts`
 * holds the two equal. Each rule is judged on its own, and the earlier row of a repeat is kept.
 */
export function credentialFaults(rows: unknown): CredentialFault[] {
  if (!Array.isArray(rows)) return [];
  const faults: CredentialFault[] = [];
  const labels = new Map<string, number>();
  const logins = new Map<string, number>();
  /** Every row a message names, named one way: its path and its label. */
  const named = (index: number) => {
    const row = rows[index] as Record<string, unknown> | null;
    return `testCredentials[${index}] ('${text(row?.label).trim()}')`;
  };
  const fault = (f: Omit<CredentialFault, 'path'>) =>
    faults.push({ ...f, path: `testCredentials.${f.index}.${f.field}` });
  rows.forEach((raw: unknown, index) => {
    if (typeof raw !== 'object' || raw === null) return;
    const row = raw as Record<string, unknown>;
    const shown = text(row.label).trim();
    const label = shown.toLowerCase();
    if (label === '') return;
    const password = text(row.password);
    const labelled = labels.get(label);
    if (labelled === undefined) labels.set(label, index);
    else {
      fault({
        index,
        field: 'label',
        rule: 'duplicate-label',
        sameAs: labelled,
        message: `${named(index)} has the label ${named(labelled)} already has, and a run picks a login by its label. Rename one of them, or remove the repeat.`,
      });
    }
    if (password.trim() === '') {
      fault({
        index,
        field: 'password',
        rule: 'password-required',
        message: `${named(index)} has no password, so nobody can log in with it. Give it the password, or remove the row.`,
      });
      return;
    }
    const login = `${text(row.username).trim().toLowerCase()}\0${password}`;
    const listed = logins.get(login);
    if (listed === undefined) logins.set(login, index);
    else {
      fault({
        index,
        field: 'username',
        rule: 'duplicate-login',
        sameAs: listed,
        message: `${named(index)} is the same username and password as ${named(listed)}, so it lists one login twice. Remove the repeat.`,
      });
    }
  });
  return faults;
}

export type TestingUrl = z.infer<typeof testingUrlSchema>;
export type TestCredential = z.infer<typeof testCredentialSchema>;

const urlField = z.string().trim().url().max(500).nullable().optional();

export const previewEnvironmentSchema = z
  .object({
    url: urlField,
    apiUrl: urlField,
    urls: z.array(testingUrlSchema).max(50).optional(),
  })
  .catchall(z.unknown());

export const liveEnvironmentSchema = z
  .object({
    url: urlField,
    apiUrl: urlField,
  })
  .catchall(z.unknown());

/** The live keys a release once read a commit from, before probes moved to the deploy binding. */
export const RETIRED_LIVE_KEYS = ['commitUrl', 'commitPath'] as const;

export function retiredLiveKeyMessage(key: (typeof RETIRED_LIVE_KEYS)[number]): string {
  return `\`environments.live.${key}\` was retired: a release no longer reads the commit it serves off the project's environments, only off the live deploy binding. Declare the probe as \`verify.probes\` on that binding — \`{"probes":[{"url":"https://<host>/version","commitPath":"sourceCommit"}]}\` — and send \`live\` with \`url\` and \`apiUrl\` only. Nothing was written.`;
}

/** Each retired key a patch names under `live`, a null included: sending it at all is refused. */
export function retiredLiveKeysIn(
  patch: Record<string, unknown>,
): (typeof RETIRED_LIVE_KEYS)[number][] {
  const live = patch.live;
  if (typeof live !== 'object' || live === null) return [];
  return RETIRED_LIVE_KEYS.filter((key) => key in live);
}

export const environmentsPatchSchema = z
  .object({
    preview: previewEnvironmentSchema.nullable().optional(),
    live: liveEnvironmentSchema.nullable().optional(),
    testCredentials: z.array(testCredentialSchema).max(50).optional(),
    limits: z.string().trim().max(8000).nullable().optional(),
  })
  .catchall(z.unknown());

export type EnvironmentsConfig = z.infer<typeof environmentsPatchSchema>;

export interface PreviewEnvironment {
  url: string | null;
  apiUrl: string | null;
  urls: TestingUrl[];
}

export interface LiveEnvironment {
  url: string | null;
  apiUrl: string | null;
}

/** What every reader gets, whatever the column holds. */
export interface NormalizedEnvironments {
  /** `null` is a one-box project saying it has no preview side, not a gap. */
  preview: PreviewEnvironment | null;
  /** ALWAYS an object: every project has a live side, and `url === null` is the askable question. */
  live: LiveEnvironment;
  testCredentials: TestCredential[];
  limits: string | null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function rows<T>(value: unknown, pick: (row: Record<string, unknown>) => T): T[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
    .map(pick);
}

/**
 * Whether the stored preview side says anything at all.
 *
 * Absent, JSON null, `{}` and a preview whose three fields are all empty are the SAME answer —
 * this project has no preview side — and they all normalise to `preview: null`. The migration
 * writes that answer once so readers do not each have to derive it.
 */
function readPreview(value: unknown): PreviewEnvironment | null {
  if (typeof value !== 'object' || value === null) return null;
  const obj = value as Record<string, unknown>;
  const preview: PreviewEnvironment = {
    url: str(obj.url),
    apiUrl: str(obj.apiUrl),
    urls: rows(obj.urls, (row) => ({ label: String(row.label ?? ''), url: String(row.url ?? '') })),
  };
  const empty = preview.url === null && preview.apiUrl === null && preview.urls.length === 0;
  return empty ? null : preview;
}

/**
 * The stored value as the full shape, for a column that may hold anything.
 *
 * ONE normaliser, because before ISS-1069 there were three: `readPreviewDeploy` in
 * `projects/service.ts`, the `forge_projects.get` handler and `loadProjectFactInputs` each read the
 * blob with `?? {}` and picked keys out of it by hand, so what the value WAS lived in no single
 * place and the three could disagree about an empty one.
 */
export function normalizeEnvironments(raw: unknown): NormalizedEnvironments {
  const obj =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const live = (typeof obj.live === 'object' && obj.live !== null ? obj.live : {}) as Record<
    string,
    unknown
  >;
  return {
    preview: readPreview(obj.preview),
    live: {
      url: str(live.url),
      apiUrl: str(live.apiUrl),
    },
    testCredentials: rows(obj.testCredentials, (row) => ({
      label: String(row.label ?? ''),
      username: String(row.username ?? ''),
      password: String(row.password ?? ''),
    })),
    limits: str(obj.limits),
  };
}

export const RETIRED_PREVIEW_DEPLOY_MESSAGE =
  'previewDeploy has been renamed to environments, which carries both sides of a deployment rather than only the preview one. Send `environments` instead: `{ preview: { url, apiUrl, urls[] } | null, live: { url, apiUrl }, testCredentials[], limits }`. `stagingUrl` is now `preview.url`, `stagingApiUrl` is `preview.apiUrl`, `testingUrls` is `preview.urls`, and `notes` is `limits` — the field asks what this environment does NOT have. `testCredentials` is unchanged. Migration 0279 already moved every value this project held.';

export const RETIRED_PREVIEW_DEPLOY_NOTES_MESSAGE =
  'previewDeployNotes has been renamed to environmentsLimits, which writes `environments.limits`. The field it replaces invited anything and was set on 4 of 32 projects; this one asks one question — what does this environment NOT have — so write the limits a run planning a live walk would otherwise discover at the testing gate. It is readable by every project member and is injected into agent prompts as `{{project:test-notes}}`, so never put a secret in it. null clears it.';

export const ENVIRONMENTS_MOVED_MESSAGE =
  '`environments` is a document rather than a column value, so it is written through its own door: `PATCH /api/projects/:id/environments` with `{ base, patch }`, where `base` is what `GET /api/projects/:id/environments` answered and `patch` names only the keys you are changing. Sent whole here, it replaced every key the sender did not resend, which is how a stored test credential disappeared behind a preview URL edit.';

export const ENVIRONMENTS_WRITE_SHAPE_MESSAGE =
  'an environments write is `{ base, patch }`: `patch` holds only the keys you are changing (`null` deletes one) and `base` is what `GET /api/projects/:id/environments` answered. A bare document is refused, because a document sent whole carries away every key the sender did not resend.';
