// The environments document as a form: both sides of a deployment (the live address a release
// ships to and the preview one QA opens), the test credentials and the limits of either. Written
// through PATCH /api/projects/:id/environments as the keys the form changed beside the values it
// read them against (ISS-1170). The Shape & release page renders it; this file holds no markup.
import { z } from "zod";
import type { EnvironmentsConfig, TestCredential, TestingUrl } from "./types";

// Backend caps (see `testingUrlSchema` / `testCredentialSchema` in core).
export const MAX_ROWS = 50;
export const LABEL_MAX = 80;
export const URL_MAX = 500;
export const USERNAME_MAX = 200;
export const PASSWORD_MAX = 500;
export const LIMITS_MAX = 8000;
export const COMMIT_PATH_MAX = 200;

export type UrlRow = TestingUrl & Record<string, unknown>;
export type CredRow = TestCredential & Record<string, unknown>;

export interface EnvironmentsDraft {
  liveUrl: string;
  liveCommitUrl: string;
  liveCommitPath: string;
  previewUrl: string;
  previewApiUrl: string;
  previewUrls: UrlRow[];
  testCredentials: CredRow[];
  limits: string;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function objects(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
    : [];
}

function urlRows(value: unknown): UrlRow[] {
  return objects(value).map((u) => ({
    ...u,
    label: String(u.label ?? ""),
    url: String(u.url ?? ""),
  }));
}

function credRows(value: unknown): CredRow[] {
  return objects(value).map((c) => ({
    ...c,
    label: String(c.label ?? ""),
    username: String(c.username ?? ""),
    password: String(c.password ?? ""),
  }));
}

/** Read the stored jsonb blob into editable form state (defensive — jsonb is
 *  typed `unknown`, so coerce every field and tolerate partial/legacy shapes). */
export function parseEnvironments(raw: unknown): EnvironmentsDraft {
  const env = (raw ?? {}) as EnvironmentsConfig;
  const live = (env.live ?? {}) as Record<string, unknown>;
  const preview = (env.preview ?? {}) as Record<string, unknown>;
  return {
    liveUrl: text(live.url),
    liveCommitUrl: text(live.commitUrl),
    liveCommitPath: text(live.commitPath),
    previewUrl: text(preview.url),
    previewApiUrl: text(preview.apiUrl),
    previewUrls: urlRows(preview.urls),
    testCredentials: credRows(env.testCredentials),
    limits: text(env.limits),
  };
}

/** Where each rendered field lives in the stored document, so a path a refusal named can be
 *  found in this form. A path the form does not render maps to nothing, which is the truth:
 *  there is no edit of the person's standing there. */
const FIELD_AT: Record<string, keyof EnvironmentsDraft> = {
  "live.url": "liveUrl",
  "live.commitUrl": "liveCommitUrl",
  "live.commitPath": "liveCommitPath",
  "preview.url": "previewUrl",
  "preview.apiUrl": "previewApiUrl",
  "preview.urls": "previewUrls",
  testCredentials: "testCredentials",
  limits: "limits",
};

export function locateField(path: readonly string[]): string[] | null {
  const key = FIELD_AT[path.join(".")];
  return key ? [key] : null;
}

export function documentPathOfField(path: readonly string[]): string[] | null {
  const at = Object.entries(FIELD_AT).find(([, key]) => key === path[0]);
  return at ? at[0].split(".") : null;
}

function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function trimmedOrNull(value: string): string | null {
  return value.trim() === "" ? null : value.trim();
}

function keptUrlRows(rows: UrlRow[]): UrlRow[] {
  return rows
    .filter((u) => u.label.trim() !== "" && u.url.trim() !== "")
    .map((u) => ({ ...u, label: u.label.trim(), url: u.url.trim() }));
}

function keptCredentials(rows: CredRow[]): CredRow[] {
  return rows
    .filter((c) => c.label.trim() !== "")
    .map((c) => ({ ...c, label: c.label.trim(), username: c.username.trim(), password: c.password }));
}

/** The document the form stands for — only the fields it renders, empty URL fields as null and
 *  blank or partial rows dropped, which is what a save sends. A stored key this form does not
 *  render is in neither side of a comparison, because neither the comparison nor the write reaches it. */
export function environmentsDocument(form: EnvironmentsDraft) {
  const urls = keptUrlRows(form.previewUrls);
  return {
    live: {
      url: trimmedOrNull(form.liveUrl),
      commitUrl: trimmedOrNull(form.liveCommitUrl),
      commitPath: trimmedOrNull(form.liveCommitPath),
    },
    preview: {
      url: trimmedOrNull(form.previewUrl),
      apiUrl: trimmedOrNull(form.previewApiUrl),
      urls: urls.length > 0 ? urls : null,
    },
    testCredentials: keptCredentials(form.testCredentials),
    limits: trimmedOrNull(form.limits),
  };
}

/** The rows a save drops because they are typed only in part. They are not in what a save sends,
 *  but they are in what the person holds, so the page counts them as an edit rather than let a
 *  half-typed row leave without a question. A row with nothing in it is not an edit. */
function partialRows(form: EnvironmentsDraft) {
  return {
    urls: form.previewUrls.filter((u) => (u.label.trim() === "") !== (u.url.trim() === "")),
    credentials: form.testCredentials.filter(
      (c) => c.label.trim() === "" && (c.username !== "" || c.password !== ""),
    ),
  };
}

/** The shape two forms are compared in for dirtiness: what a save sends, and what it would drop. */
export function environmentsComparable(form: EnvironmentsDraft) {
  return { document: environmentsDocument(form), partial: partialRows(form) };
}

const URL_MESSAGE = "Enter a valid URL (including http(s)://).";

const optionalUrl = z.string().refine((v) => v.trim() === "" || isValidUrl(v.trim()), URL_MESSAGE);

const urlRow = z.looseObject({ label: z.string(), url: z.string() }).superRefine((row, ctx) => {
  const label = row.label.trim();
  const url = row.url.trim();
  if (label === "" && url === "") return;
  if (label === "") ctx.addIssue({ code: "custom", message: "Label is required." });
  else if (url === "") ctx.addIssue({ code: "custom", message: "URL is required." });
  else if (!isValidUrl(url)) ctx.addIssue({ code: "custom", message: URL_MESSAGE });
});

const credentialRow = z
  .looseObject({ label: z.string(), username: z.string(), password: z.string() })
  .superRefine((row, ctx) => {
    if (row.label.trim() === "" && (row.username !== "" || row.password !== "")) {
      ctx.addIssue({ code: "custom", message: "Label is required." });
    }
  });

export const environmentsSchema = z.object({
  liveUrl: optionalUrl,
  liveCommitUrl: optionalUrl,
  liveCommitPath: z.string(),
  previewUrl: optionalUrl,
  previewApiUrl: optionalUrl,
  previewUrls: z.array(urlRow),
  testCredentials: z.array(credentialRow),
  limits: z.string(),
}) as unknown as z.ZodType<EnvironmentsDraft, EnvironmentsDraft>;

