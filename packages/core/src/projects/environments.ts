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

/** The keys the environments document has, at each level a patch may name one. Rows under
 *  `preview.urls` and `testCredentials` are replaced whole and keep what they carry. */
const DOCUMENT_KEYS = {
  '': ['preview', 'live', 'testCredentials', 'limits'],
  preview: ['url', 'apiUrl', 'urls'],
  live: ['url', 'apiUrl'],
} as const;

export const ENVIRONMENTS_SHAPE =
  '`{ preview: { url, apiUrl, urls[] } | null, live: { url, apiUrl }, testCredentials[], limits }`';

/** A key a patch sends that the document does not take: retired, or never one of its keys. */
export interface RefusedKey {
  path: string;
  why: 'retired' | 'unknown';
  message: string;
  /** The retired field a `retired` key names, `live.commitUrl` however it was spelled. */
  field?: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const RETIRED_WHY =
  'a release no longer reads the commit it serves off the project\'s environments, only off the live deploy binding. Declare the probe as `verify.probes` on that binding — `{"probes":[{"url":"https://<host>/version","commitPath":"sourceCommit"}]}` — and send `live` with `url` and `apiUrl` only.';

/** How a retired field is named in a refusal: as the field, and as sent where the two differ. */
function retiredName(path: string, field: string): string {
  const named = `\`environments.${field}\``;
  return path === field || path === `environments.${field}`
    ? named
    : `${named} (sent as \`${path}\`)`;
}

function refusal(path: string, why: RefusedKey['why'], field?: string): RefusedKey {
  return why === 'retired' && field
    ? { path, why, field, message: `${retiredName(path, field)} was retired: ${RETIRED_WHY}` }
    : {
        path,
        why,
        message: `\`${path}\` is not a key of the environments document, which is ${ENVIRONMENTS_SHAPE}.`,
      };
}

const spelled = (segment: string) => segment.toLowerCase().replace(/[_-]/g, '');

/**
 * The retired live field a sent key's path names in any spelling: dotted inside one key
 * (`live.commitUrl`), prefixed with the document's own name (`environments.live.commitUrl`), or
 * cased or separated otherwise (`commit_url`, `commitURL`). Null where it names none.
 */
function retiredFieldOf(path: string): string | null {
  const segments = path.split('.').filter((s) => s !== '');
  if (segments.length > 0 && spelled(segments[0] as string) === 'environments') segments.shift();
  if (segments.length !== 2 || spelled(segments[0] as string) !== 'live') return null;
  const key = RETIRED_LIVE_KEYS.find((k) => spelled(k) === spelled(segments[1] as string));
  return key ? `live.${key}` : null;
}

/**
 * Each key a patch sends that the document does not have, in the order sent. A retired live key is
 * refused in any spelling `retiredFieldOf` reads and whatever it is sent as, a null included. A null sent for any other key the STORED
 * document holds deletes a stray written before this check, which is the one way such a key leaves;
 * a stray nobody sends is carried as stored.
 */
export function refusedKeysIn(
  patch: Record<string, unknown>,
  stored: Record<string, unknown>,
): RefusedKey[] {
  const refused: RefusedKey[] = [];
  for (const [level, allowed] of Object.entries(DOCUMENT_KEYS)) {
    const sent = level === '' ? patch : patch[level];
    const held = level === '' ? stored : stored[level];
    if (!isObject(sent)) continue;
    for (const [key, value] of Object.entries(sent)) {
      const path = level === '' ? key : `${level}.${key}`;
      const retired = (allowed as readonly string[]).includes(key) ? null : retiredFieldOf(path);
      if (retired) {
        refused.push(refusal(path, 'retired', retired));
      } else if (!(allowed as readonly string[]).includes(key)) {
        if (value === null && isObject(held) && Object.hasOwn(held, key)) continue;
        refused.push(refusal(path, 'unknown'));
      }
    }
  }
  return refused;
}

function listed(names: string[]): string {
  return names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** One refusal for every key a patch sent that the document does not take, each named once. */
export function refusedKeysMessage(refused: readonly RefusedKey[]): string {
  const named = new Map<string, string>();
  for (const r of refused) {
    if (r.why === 'retired' && r.field && !named.has(r.field))
      named.set(r.field, retiredName(r.path, r.field));
  }
  const retired = [...named.values()];
  const unknown = refused.filter((r) => r.why === 'unknown').map((r) => `\`${r.path}\``);
  const said: string[] = [];
  if (retired.length > 0) {
    said.push(
      `${listed(retired)} ${retired.length === 1 ? 'was' : 'were'} retired: ${RETIRED_WHY}`,
    );
  }
  if (unknown.length > 0) {
    said.push(
      `${listed(unknown)} ${unknown.length === 1 ? 'is not a key' : 'are not keys'} of the environments document, which is ${ENVIRONMENTS_SHAPE}: a key it does not have is refused rather than stored where nothing reads it.`,
    );
  }
  return [...said, 'Nothing was written.'].join(' ');
}

/**
 * The MERGED document a write would store. It passes a key it does not name because the stored
 * side may carry one written before `refusedKeysIn` held what a patch sends, and that key is
 * carried rather than refused on a write that never named it.
 */
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
