"use client";

// Project settings → Testing. View/edit the project's `environments` blob: BOTH sides of the
// deployment — the live address a release ships to and the preview one QA opens — plus the test
// credentials and the limits of either. Written through PATCH /api/projects/:id/environments
// (owner-gated, validated by `environmentsPatchSchema`) as the keys this form changed beside
// the values it read them against; `PATCH /api/projects/:id` refuses `environments` by name
// (ISS-1170). Passwords are masked by default with a per-row reveal; values are never logged.
import { useState } from "react";
import { z } from "zod";
import {
  Button,
  ErrorState,
  Field,
  IconButton,
  Input,
  SectionTitle,
  SettingsFormBar,
  Skeleton,
  Textarea,
  useSettingsForm,
  SettingsSection,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { documentWrite } from "../document-write";
import { useEnvironments, useUpdateEnvironments } from "../hooks";
import type { EnvironmentsConfig, TestCredential, TestingUrl } from "../types";
import { SaveRefusedBanner } from "./save-refused-banner";

// Backend caps (see `testingUrlSchema` / `testCredentialSchema` in core).
const MAX_ROWS = 50;
const LABEL_MAX = 80;
const URL_MAX = 500;
const USERNAME_MAX = 200;
const PASSWORD_MAX = 500;
const LIMITS_MAX = 8000;
const COMMIT_PATH_MAX = 200;

type UrlRow = TestingUrl & Record<string, unknown>;
type CredRow = TestCredential & Record<string, unknown>;

interface Form {
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
function parse(raw: unknown): Form {
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
const FIELD_AT: Record<string, keyof Form> = {
  "live.url": "liveUrl",
  "live.commitUrl": "liveCommitUrl",
  "live.commitPath": "liveCommitPath",
  "preview.url": "previewUrl",
  "preview.apiUrl": "previewApiUrl",
  "preview.urls": "previewUrls",
  testCredentials: "testCredentials",
  limits: "limits",
};

function locateField(path: readonly string[]): string[] | null {
  const key = FIELD_AT[path.join(".")];
  return key ? [key] : null;
}

function documentPathOfField(path: readonly string[]): string[] | null {
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
function documentOf(form: Form) {
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
function partialRows(form: Form) {
  return {
    urls: form.previewUrls.filter((u) => (u.label.trim() === "") !== (u.url.trim() === "")),
    credentials: form.testCredentials.filter(
      (c) => c.label.trim() === "" && (c.username !== "" || c.password !== ""),
    ),
  };
}

/** The shape two forms are compared in for dirtiness: what a save sends, and what it would drop. */
function comparableOf(form: Form) {
  return { document: documentOf(form), partial: partialRows(form) };
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

const testingSchema = z.object({
  liveUrl: optionalUrl,
  liveCommitUrl: optionalUrl,
  liveCommitPath: z.string(),
  previewUrl: optionalUrl,
  previewApiUrl: optionalUrl,
  previewUrls: z.array(urlRow),
  testCredentials: z.array(credentialRow),
  limits: z.string(),
}) as unknown as z.ZodType<Form, Form>;

export function TestingTab({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const envQ = useEnvironments(projectId);

  // No form before the document is in hand: a blank one over an unread document would let
  // somebody type against a base nobody has seen.
  if (envQ.isPending) {
    return (
      <SettingsSection>
        <div className="space-y-3">
          <Skeleton className="h-10 w-full rounded-md" />
          <Skeleton className="h-10 w-full rounded-md" />
          <Skeleton className="h-10 w-full rounded-md" />
        </div>
      </SettingsSection>
    );
  }

  if (envQ.isError) {
    return (
      <SettingsSection>
        <ErrorState message={formatApiError(envQ.error)} onRetry={() => envQ.refetch()} />
      </SettingsSection>
    );
  }

  return (
    <TestingPage
      projectId={projectId}
      canEdit={canEdit}
      environments={envQ.data?.environments}
      readRevision={envQ.dataUpdatedAt}
    />
  );
}

function TestingPage({
  projectId,
  canEdit,
  environments,
  readRevision,
}: {
  projectId: string;
  canEdit: boolean;
  /** The document as stored: this form writes it, and a write's `base` is read from it. */
  environments: unknown;
  /** Changes each time that document is read, even when it read the same thing. */
  readRevision: number;
}) {
  const update = useUpdateEnvironments(projectId);
  const held = useSettingsForm<Form>({
    read: parse(environments),
    schema: testingSchema,
    locate: locateField,
    documentPathOf: documentPathOfField,
    comparable: comparableOf,
    readRevision,
  });
  const form = held.draft;
  const setForm = held.setDraft;
  const [revealed, setRevealed] = useState<Set<number>>(new Set());

  const liveUrlError = held.errorAt("liveUrl");
  const liveCommitUrlError = held.errorAt("liveCommitUrl");
  const previewUrlError = held.errorAt("previewUrl");
  const previewApiUrlError = held.errorAt("previewApiUrl");
  const testingUrlError = (i: number) => held.errorAt(`previewUrls.${i}`);
  const credentialError = (i: number) => held.errorAt(`testCredentials.${i}`);

  function setField(key: keyof Form, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function setUrlRow(index: number, patch: Partial<UrlRow>) {
    setForm((f) => ({
      ...f,
      previewUrls: f.previewUrls.map((r, i) => (i === index ? { ...r, ...patch } : r)),
    }));
  }
  function addUrlRow() {
    setForm((f) =>
      f.previewUrls.length >= MAX_ROWS
        ? f
        : { ...f, previewUrls: [...f.previewUrls, { label: "", url: "" }] },
    );
  }
  function removeUrlRow(index: number) {
    setForm((f) => ({ ...f, previewUrls: f.previewUrls.filter((_, i) => i !== index) }));
  }

  function setCredRow(index: number, patch: Partial<CredRow>) {
    setForm((f) => ({
      ...f,
      testCredentials: f.testCredentials.map((r, i) => (i === index ? { ...r, ...patch } : r)),
    }));
  }
  function addCredRow() {
    setForm((f) =>
      f.testCredentials.length >= MAX_ROWS
        ? f
        : {
            ...f,
            testCredentials: [...f.testCredentials, { label: "", username: "", password: "" }],
          },
    );
  }
  function removeCredRow(index: number) {
    setForm((f) => ({ ...f, testCredentials: f.testCredentials.filter((_, i) => i !== index) }));
    setRevealed((prev) => {
      const next = new Set<number>();
      prev.forEach((i) => {
        if (i < index) next.add(i);
        else if (i > index) next.add(i - 1);
      });
      return next;
    });
  }
  function toggleReveal(index: number) {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  // Only the fields this form renders, and only where their value moved. Clearing every
  // rendered preview field sends `null` for those three keys alone: a key the form never
  // showed is named by no path here, so nothing can carry it away (ISS-1170).
  async function save() {
    update.reset();
    await held.save(async (now) => {
      const write = documentWrite(documentOf(held.seeded), documentOf(now), environments);
      if (write) await update.mutateAsync(write);
    });
  }

  return (
    <div className="space-y-6">
      <SettingsSection>
        <SectionTitle className="fg-h3 mb-1">What this environment does not have</SectionTitle>
        <p className="fg-caption mb-4 text-muted">
          The settings below say what exists. This one says what does <i>not</i>. Agents read it
          before planning a live test, so a limit written here is caught while work is still being
          scoped instead of after the code is finished. Everyone on the project can read it
          &mdash; never put a password here, use Test credentials below.
        </p>
        <Field
          label="Limits"
          hint="What a test account cannot reach, states this environment never contains, anything that must not be faked."
        >
          <Textarea
            value={form.limits}
            onChange={(e) => setField("limits", e.target.value)}
            disabled={!canEdit}
            rows={8}
            maxLength={LIMITS_MAX}
            aria-label="Environment limits"
            placeholder={
              "e.g.\n- The QA account is not a member of every project — check before promising a live walk.\n- No issue ever rests at the release gate here, so anything triggered by that state cannot be exercised.\n- Runner health must not be faked; it would break live work."
            }
          />
        </Field>
        <p className="fg-caption mt-2 text-muted">
          {form.limits.length.toLocaleString()} / {LIMITS_MAX.toLocaleString()}
        </p>
      </SettingsSection>

      <SettingsSection>
        <SectionTitle className="fg-h3 mb-1">Live</SectionTitle>
        <p className="fg-caption mb-4 text-muted">
          Where a release of this project actually ships. Without the commit endpoint below, every
          live deploy binding has to declare its own verification probe, and a release is refused
          until one does.
        </p>
        <div className="space-y-4">
          <Field
            label="Live URL"
            hint="The address a person opens, e.g. https://app.example.com"
            error={liveUrlError}
          >
            <Input
              value={form.liveUrl}
              onChange={(e) => setField("liveUrl", e.target.value)}
              disabled={!canEdit}
              placeholder="https://app.example.com"
              maxLength={URL_MAX}
              inputMode="url"
            />
          </Field>
          <Field
            label="Live commit endpoint"
            hint="The endpoint that reports the running commit — often a different address from the one above, e.g. https://api.example.com/health"
            error={liveCommitUrlError}
          >
            <Input
              value={form.liveCommitUrl}
              onChange={(e) => setField("liveCommitUrl", e.target.value)}
              disabled={!canEdit}
              placeholder="https://api.example.com/health"
              maxLength={URL_MAX}
              inputMode="url"
            />
          </Field>
          <Field
            label="Live commit path"
            hint="Dot path to the commit inside that endpoint's JSON body — e.g. commit, or data.commit. Leave it blank where the whole response body is the commit."
          >
            <Input
              value={form.liveCommitPath}
              onChange={(e) => setField("liveCommitPath", e.target.value)}
              disabled={!canEdit}
              placeholder="commit"
              maxLength={COMMIT_PATH_MAX}
            />
          </Field>
        </div>
      </SettingsSection>

      <SettingsSection>
        <SectionTitle className="fg-h3 mb-1">Preview</SectionTitle>
        <p className="fg-caption mb-4 text-muted">
          A separate deployment QA opens before a release. Leaving all three blank says this
          project has no preview side, which is normal for a one-box project &mdash; nothing
          reports it as missing.
        </p>
        <div className="space-y-4">
          <Field
            label="Preview URL"
            hint="Frontend URL, e.g. https://staging.example.com"
            error={previewUrlError}
          >
            <Input
              value={form.previewUrl}
              onChange={(e) => setField("previewUrl", e.target.value)}
              disabled={!canEdit}
              placeholder="https://staging.example.com"
              maxLength={URL_MAX}
              inputMode="url"
            />
          </Field>
          <Field
            label="Preview API URL"
            hint="Backend/API base URL."
            error={previewApiUrlError}
          >
            <Input
              value={form.previewApiUrl}
              onChange={(e) => setField("previewApiUrl", e.target.value)}
              disabled={!canEdit}
              placeholder="https://api.staging.example.com"
              maxLength={URL_MAX}
              inputMode="url"
            />
          </Field>
        </div>
      </SettingsSection>

      <SettingsSection>
        <SectionTitle className="fg-h3 mb-1">Testing URLs</SectionTitle>
        <p className="fg-caption mb-4 text-muted">
          Named links QA opens while verifying the preview side — admin panels, mailbox,
          dashboards.
        </p>
        {form.previewUrls.length === 0 ? (
          <p className="fg-body-sm text-muted">No testing URLs.</p>
        ) : (
          <ul className="space-y-3">
            {form.previewUrls.map((row, i) => {
              const err = testingUrlError(i);
              return (
                <li key={i} className="flex items-start gap-2">
                  <div className="w-40 shrink-0">
                    <Input
                      value={row.label}
                      onChange={(e) => setUrlRow(i, { label: e.target.value })}
                      disabled={!canEdit}
                      placeholder="Label"
                      maxLength={LABEL_MAX}
                      aria-label={`Testing URL ${i + 1} label`}
                    />
                  </div>
                  <div className="flex-1">
                    <Input
                      value={row.url}
                      onChange={(e) => setUrlRow(i, { url: e.target.value })}
                      disabled={!canEdit}
                      placeholder="https://…"
                      maxLength={URL_MAX}
                      inputMode="url"
                      aria-label={`Testing URL ${i + 1} address`}
                      aria-invalid={err ? true : undefined}
                    />
                    {err && (
                      <p role="alert" className="fg-caption mt-1" style={{ color: "var(--red-600)" }}>
                        {err}
                      </p>
                    )}
                  </div>
                  {canEdit && (
                    <IconButton
                      icon="trash"
                      aria-label={`Remove testing URL ${i + 1}`}
                      onClick={() => removeUrlRow(i)}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {canEdit && (
          <div className="mt-4">
            <Button
              variant="secondary"
              icon="plus"
              onClick={addUrlRow}
              disabled={form.previewUrls.length >= MAX_ROWS}
              className="min-h-11"
            >
              Add URL
            </Button>
          </div>
        )}
      </SettingsSection>

      <SettingsSection>
        <SectionTitle className="fg-h3 mb-1">Test credentials</SectionTitle>
        <p className="fg-caption mb-4 text-muted">
          Login accounts QA uses against either side. Passwords are masked by default.
        </p>
        {form.testCredentials.length === 0 ? (
          <p className="fg-body-sm text-muted">No test credentials.</p>
        ) : (
          <ul className="divide-y divide-line">
            {form.testCredentials.map((row, i) => {
              const err = credentialError(i);
              return (
                <li key={i} className="py-3">
                  <div className="flex items-start gap-2">
                    <div className="grid flex-1 gap-2 sm:grid-cols-3">
                      <Input
                        value={row.label}
                        onChange={(e) => setCredRow(i, { label: e.target.value })}
                        disabled={!canEdit}
                        placeholder="Label (e.g. Admin)"
                        maxLength={LABEL_MAX}
                        aria-label={`Credential ${i + 1} label`}
                        aria-invalid={err ? true : undefined}
                      />
                      <Input
                        value={row.username}
                        onChange={(e) => setCredRow(i, { username: e.target.value })}
                        disabled={!canEdit}
                        placeholder="Username"
                        maxLength={USERNAME_MAX}
                        autoComplete="off"
                        aria-label={`Credential ${i + 1} username`}
                      />
                      <div className="flex items-center gap-2">
                        <Input
                          value={row.password}
                          onChange={(e) => setCredRow(i, { password: e.target.value })}
                          disabled={!canEdit}
                          placeholder="Password"
                          type={revealed.has(i) ? "text" : "password"}
                          maxLength={PASSWORD_MAX}
                          autoComplete="off"
                          aria-label={`Credential ${i + 1} password`}
                          className="flex-1"
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => toggleReveal(i)}
                          aria-label={revealed.has(i) ? "Hide password" : "Show password"}
                          className="shrink-0"
                        >
                          {revealed.has(i) ? "Hide" : "Show"}
                        </Button>
                      </div>
                    </div>
                    {canEdit && (
                      <IconButton
                        icon="trash"
                        aria-label={`Remove credential ${i + 1}`}
                        onClick={() => removeCredRow(i)}
                      />
                    )}
                  </div>
                  {err && (
                    <p role="alert" className="fg-caption mt-2" style={{ color: "var(--red-600)" }}>
                      {err}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {canEdit && (
          <div className="mt-4">
            <Button
              variant="secondary"
              icon="plus"
              onClick={addCredRow}
              disabled={form.testCredentials.length >= MAX_ROWS}
              className="min-h-11"
            >
              Add credential
            </Button>
          </div>
        )}
      </SettingsSection>

      {canEdit && (
        <SettingsFormBar
          dirty={held.dirty}
          saving={update.isPending}
          blockedBy={held.invalid ? "Fix what is marked above before saving." : null}
          onSave={() => void save().catch(() => undefined)}
          onDiscard={() => {
            update.reset();
            held.discard();
          }}
        >
          <SaveRefusedBanner
            projectId={projectId}
            error={update.isError ? update.error : null}
            onDismiss={() => update.reset()}
            document="environments"
            draft={held}
          />
        </SettingsFormBar>
      )}
    </div>
  );
}
