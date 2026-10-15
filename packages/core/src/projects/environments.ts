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

/** Why a written credential is refused: no password to log in with, or a second row for a login already listed. */
export type CredentialRule = 'password-required' | 'duplicate-label' | 'duplicate-login';

export interface CredentialFault {
  /** The document path of the field at fault, e.g. `testCredentials.1.password`. */
  path: string;
  rule: CredentialRule;
  message: string;
}

const fold = (value: unknown) => (typeof value === 'string' ? value.trim().toLowerCase() : '');

/**
 * The credential rows a write may not store. A row is a login QA uses, so it carries a password;
 * its label is the name a run picks it by, so no two share one; and the same username and password
 * twice is one login listed twice. Each later row is the one named, so the first stays as it is.
 */
export function credentialFaults(rows: unknown): CredentialFault[] {
  if (!Array.isArray(rows)) return [];
  const faults: CredentialFault[] = [];
  const labels = new Map<string, number>();
  const logins = new Map<string, number>();
  rows.forEach((raw, i) => {
    if (typeof raw !== 'object' || raw === null) return;
    const row = raw as Record<string, unknown>;
    const label = typeof row.label === 'string' ? row.label.trim() : '';
    const password = typeof row.password === 'string' ? row.password : '';
    if (password.trim() === '') {
      faults.push({
        path: `testCredentials.${i}.password`,
        rule: 'password-required',
        message: `testCredentials[${i}] ('${label}') has no password, so nobody can log in with it. Give it the password, or remove the row.`,
      });
    }
    const sameLabel = labels.get(fold(label));
    if (label !== '' && sameLabel !== undefined) {
      faults.push({
        path: `testCredentials.${i}.label`,
        rule: 'duplicate-label',
        message: `testCredentials[${i}] is labelled '${label}', as testCredentials[${sameLabel}] is, and a run picks a login by its label. Rename one of them, or remove the repeat.`,
      });
    } else if (label !== '') labels.set(fold(label), i);
    const login = `${fold(row.username)}\0${password}`;
    const sameLogin = logins.get(login);
    if (password.trim() !== '' && sameLogin !== undefined && sameLabel === undefined) {
      faults.push({
        path: `testCredentials.${i}.username`,
        rule: 'duplicate-login',
        message: `testCredentials[${i}] ('${label}') is the same username and password as testCredentials[${sameLogin}], so it lists one login twice. Remove the repeat.`,
      });
    } else if (password.trim() !== '' && sameLogin === undefined) logins.set(login, i);
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
    commitUrl: urlField,
    commitPath: z.string().trim().max(200).nullable().optional(),
  })
  .catchall(z.unknown());

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
  commitUrl: string | null;
  commitPath: string | null;
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
      commitUrl: str(live.commitUrl),
      commitPath: str(live.commitPath),
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
  'previewDeploy has been renamed to environments, which carries both sides of a deployment rather than only the preview one. Send `environments` instead: `{ preview: { url, apiUrl, urls[] } | null, live: { url, apiUrl, commitUrl, commitPath }, testCredentials[], limits }`. `stagingUrl` is now `preview.url`, `stagingApiUrl` is `preview.apiUrl`, `testingUrls` is `preview.urls`, and `notes` is `limits` — the field asks what this environment does NOT have. `testCredentials` is unchanged. Migration 0279 already moved every value this project held.';

export const RETIRED_PREVIEW_DEPLOY_NOTES_MESSAGE =
  'previewDeployNotes has been renamed to environmentsLimits, which writes `environments.limits`. The field it replaces invited anything and was set on 4 of 32 projects; this one asks one question — what does this environment NOT have — so write the limits a run planning a live walk would otherwise discover at the testing gate. It is readable by every project member and is injected into agent prompts as `{{project:test-notes}}`, so never put a secret in it. null clears it.';

export const ENVIRONMENTS_MOVED_MESSAGE =
  '`environments` is a document rather than a column value, so it is written through its own door: `PATCH /api/projects/:id/environments` with `{ base, patch }`, where `base` is what `GET /api/projects/:id/environments` answered and `patch` names only the keys you are changing. Sent whole here, it replaced every key the sender did not resend, which is how a stored test credential disappeared behind a preview URL edit.';

export const ENVIRONMENTS_WRITE_SHAPE_MESSAGE =
  'an environments write is `{ base, patch }`: `patch` holds only the keys you are changing (`null` deletes one) and `base` is what `GET /api/projects/:id/environments` answered. A bare document is refused, because a document sent whole carries away every key the sender did not resend.';
