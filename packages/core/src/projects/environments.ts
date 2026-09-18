// What a project is deployed to, both sides of it.
//
// Until ISS-1069 this column was `preview_deploy` and it held half the world:
// a staging URL, a staging API URL, some labelled testing links, the QA
// credentials and a free-text `notes`. There was no column anywhere in the
// schema for the address of the thing a release ships TO. The only place one
// fitted was `verify.probes` inside a deploy binding's config, which 0 of 32
// projects filled — mechanically rather than lazily, because the agent is told
// the deploy channel and never told where the result lives.
//
// The cost was measured on 2026-09-17: `sidpeak` could not cut a release at
// all. It refused at `RELEASE_PROBES_UNDECLARED`, and declaring the probe
// needed the one thing Forge did not hold — its own production hostname. Its
// two recorded URLs both served `origin/staging`, its live and preview
// bindings pointed at different Coolify applications, and the live address was
// written nowhere: not on the project, not on the binding, not in the
// repository. The only way to finish that release was for a person to open the
// Coolify UI and read the domain off the application by hand.
//
// So the shape carries both sides, and an absent preview is a one-box project
// SAYING so rather than a gap somebody forgot to fill.

import { z } from 'zod';

// cm:why the row catchall is new in ISS-1069 and is a fix rather than a copy: the top level passed
// unknown keys THROUGH so a client one version ahead is not truncated by this one, and one level
// down a plain `z.object` stripped them silently — the same 200-and-a-discard the retired keys are
// refused by name to avoid. The rules themselves are unchanged from `previewDeployPatchSchema`.
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

export type TestingUrl = z.infer<typeof testingUrlSchema>;
export type TestCredential = z.infer<typeof testCredentialSchema>;

const urlField = z.string().trim().url().max(500).nullable().optional();

// cm:why free-form jsonb with unknown keys passing THROUGH at every level rather than being
// stripped: a deploy knob added later must reach the column without a migration, and a client one
// version ahead must not have its field silently deleted by this one. Inherited from
// `previewDeployPatchSchema`, kept deliberately rather than by omission.
export const previewEnvironmentSchema = z
  .object({
    url: urlField,
    apiUrl: urlField,
    urls: z.array(testingUrlSchema).max(50).optional(),
  })
  .catchall(z.unknown());

// cm:guard THREE fields and not one, and none of them is derivable from another. `url` is the
// address a person opens — what the release ships to. `commitUrl` is the endpoint that reports the
// running commit, which on this fleet is a different address. `commitPath` is the dot path into
// that endpoint's JSON body, and the fleet does not agree on one: `sid-desk` answers
// `{"commit":"…"}` and `sidpeak` answers `{"data":{"commit":"…","source":"artefact"}}`. Deriving
// `commitUrl` from `url` by appending a health path is hostname guessing, and a probe built from
// `url` alone hands `verifyDeployed` a whole JSON body as an identity — `readProbe` with no
// `commitPath` returns the trimmed body, which never equals a commit.
export const liveEnvironmentSchema = z
  .object({
    url: urlField,
    apiUrl: urlField,
    commitUrl: urlField,
    commitPath: z.string().trim().max(200).nullable().optional(),
  })
  .catchall(z.unknown());

// cm:guard `testCredentials` keeps this exact spelling at the TOP level, because
// `SCRUB_BODY_KEYS` in `@forge/observability` matches on the KEY NAME and not on a path. A
// scrubber that stops matching does not fail — it succeeds, and the secret goes to a log.
// cm:edge lockstep -> packages/observability/src/index.ts — the key name here and the entry there are one decision; renaming this field without adding the new name there redacts nothing and says nothing.
// cm:guard `limits` and not `notes`. The field it replaces asked for anything and was set on 4 of
// 32 projects; this one asks what this environment does NOT have, which is the question a run
// planning a live walk actually needs answered. The reserved fact key stays `test-notes` — see
// `prompt/facts/resolve.ts` — because skill bodies in other repositories splice it and an
// unresolved `{{project:<key>}}` renders as the empty string.
export const environmentsPatchSchema = z
  .object({
    preview: previewEnvironmentSchema.nullable().optional(),
    // cm:why `live` takes JSON null as well as absence even though the READING is always an
    // object: the two say the same thing — nothing declared about that side — and a client that
    // clears a side by sending null would otherwise be refused for a value the normaliser already
    // resolves. `preview` above has taken null since it was written, and the two sides answering
    // differently to the same input is the sort of asymmetry no caller can guess.
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

/**
 * ISS-1069 — the retired keys, refused by name on every door that used to take them.
 *
 * Dropping a key from a non-strict zod object answers the operator's save with a `200` and a
 * silent discard, which is the shape ISS-994, ISS-1000 and ISS-1048 each established and the reason
 * these are messages rather than deletions.
 */
export const RETIRED_PREVIEW_DEPLOY_MESSAGE =
  'previewDeploy has been renamed to environments, which carries both sides of a deployment rather than only the preview one. Send `environments` instead: `{ preview: { url, apiUrl, urls[] } | null, live: { url, apiUrl, commitUrl, commitPath }, testCredentials[], limits }`. `stagingUrl` is now `preview.url`, `stagingApiUrl` is `preview.apiUrl`, `testingUrls` is `preview.urls`, and `notes` is `limits` — the field asks what this environment does NOT have. `testCredentials` is unchanged. Migration 0279 already moved every value this project held.';

export const RETIRED_PREVIEW_DEPLOY_NOTES_MESSAGE =
  'previewDeployNotes has been renamed to environmentsLimits, which writes `environments.limits`. The field it replaces invited anything and was set on 4 of 32 projects; this one asks one question — what does this environment NOT have — so write the limits a run planning a live walk would otherwise discover at the testing gate. It is readable by every project member and is injected into agent prompts as `{{project:test-notes}}`, so never put a secret in it. null clears it.';
