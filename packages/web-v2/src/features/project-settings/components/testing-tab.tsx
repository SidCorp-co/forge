"use client";

// Project settings → Testing. View/edit the project's `environments` blob: BOTH sides of the
// deployment — the live address a release ships to and the preview one QA opens — plus the test
// credentials and the limits of either. Persisted via PATCH /api/projects/:id (owner-gated
// server-side, validated by `environmentsPatchSchema`). Mirrors the basics-tab dirty/save pattern
// and the labels-tab add/remove-row UI. Passwords are masked by default with a per-row reveal
// toggle; values are never logged.
import { useEffect, useMemo, useState } from "react";
import { Button, Card, CardContent, Field, IconButton, Input, Textarea } from "@/design";
import type { ProjectDetail } from "@/features/projects/types";
import { useUpdateProject } from "../hooks";
import type { EnvironmentsConfig, TestCredential, TestingUrl } from "../types";

// Backend caps (see `testingUrlSchema` / `testCredentialSchema` in core).
const MAX_ROWS = 50;
const LABEL_MAX = 80;
const URL_MAX = 500;
const USERNAME_MAX = 200;
const PASSWORD_MAX = 500;
const LIMITS_MAX = 8000;
const COMMIT_PATH_MAX = 200;

interface Form {
  liveUrl: string;
  liveCommitUrl: string;
  liveCommitPath: string;
  previewUrl: string;
  previewApiUrl: string;
  previewUrls: TestingUrl[];
  testCredentials: TestCredential[];
  limits: string;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function urlRows(value: unknown): TestingUrl[] {
  return Array.isArray(value)
    ? value.map((u) => ({
        label: String((u as TestingUrl)?.label ?? ""),
        url: String((u as TestingUrl)?.url ?? ""),
      }))
    : [];
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
    testCredentials: Array.isArray(env.testCredentials)
      ? env.testCredentials.map((c) => ({
          label: String((c as TestCredential)?.label ?? ""),
          username: String((c as TestCredential)?.username ?? ""),
          password: String((c as TestCredential)?.password ?? ""),
        }))
      : [],
    limits: text(env.limits),
  };
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

function keptUrlRows(rows: TestingUrl[]): TestingUrl[] {
  return rows
    .filter((u) => u.label.trim() !== "" && u.url.trim() !== "")
    .map((u) => ({ label: u.label.trim(), url: u.url.trim() }));
}

function keptCredentials(rows: TestCredential[]): TestCredential[] {
  return rows
    .filter((c) => c.label.trim() !== "")
    .map((c) => ({ label: c.label.trim(), username: c.username.trim(), password: c.password }));
}

// cm:guard the SAME emptiness rule `normalizeEnvironments` applies server-side, so a tab that touched no preview field saves the `preview: null` it was given rather than an empty object. A null preview is a one-box project SAYING it has no other side; writing `{}` over it turns a statement into a gap somebody has to re-derive (ISS-1069).
function previewDeclared(form: Form): boolean {
  return (
    form.previewUrl.trim() !== "" ||
    form.previewApiUrl.trim() !== "" ||
    keptUrlRows(form.previewUrls).length > 0
  );
}

/** Canonical JSON of the known fields, used for dirty detection. Empty URL fields normalize to
 *  null; blank/partial rows are dropped — matching what the save path actually sends, so a
 *  freshly-loaded form reads as not-dirty. */
function canonical(form: Form): string {
  return JSON.stringify({
    live: {
      url: trimmedOrNull(form.liveUrl),
      commitUrl: trimmedOrNull(form.liveCommitUrl),
      commitPath: trimmedOrNull(form.liveCommitPath),
    },
    preview: previewDeclared(form)
      ? {
          url: trimmedOrNull(form.previewUrl),
          apiUrl: trimmedOrNull(form.previewApiUrl),
          urls: keptUrlRows(form.previewUrls),
        }
      : null,
    testCredentials: keptCredentials(form.testCredentials),
    limits: trimmedOrNull(form.limits),
  });
}

export function TestingTab({ project, canEdit }: { project: ProjectDetail; canEdit: boolean }) {
  const update = useUpdateProject(project.id);

  const [form, setForm] = useState<Form>(() => parse(project.environments));
  const [revealed, setRevealed] = useState<Set<number>>(new Set());

  // Re-hydrate when the project refetches (e.g. after a save invalidates it).
  useEffect(() => {
    setForm(parse(project.environments));
    setRevealed(new Set());
  }, [project.environments]);

  const original = useMemo(() => canonical(parse(project.environments)), [project.environments]);
  const dirty = canonical(form) !== original;

  // Validation — block save on malformed URLs or partially-filled rows.
  function urlError(value: string): string | undefined {
    return value.trim() !== "" && !isValidUrl(value.trim())
      ? "Enter a valid URL (including http(s)://)."
      : undefined;
  }
  const liveUrlError = urlError(form.liveUrl);
  const liveCommitUrlError = urlError(form.liveCommitUrl);
  const previewUrlError = urlError(form.previewUrl);
  const previewApiUrlError = urlError(form.previewApiUrl);

  function testingUrlError(row: TestingUrl): string | undefined {
    const label = row.label.trim();
    const url = row.url.trim();
    if (label === "" && url === "") return undefined; // empty row — dropped on save
    if (label === "") return "Label is required.";
    if (url === "") return "URL is required.";
    if (!isValidUrl(url)) return "Enter a valid URL (including http(s)://).";
    return undefined;
  }

  function credentialError(row: TestCredential): string | undefined {
    if (row.label.trim() === "" && (row.username !== "" || row.password !== "")) {
      return "Label is required.";
    }
    return undefined;
  }

  const hasErrors =
    !!liveUrlError ||
    !!liveCommitUrlError ||
    !!previewUrlError ||
    !!previewApiUrlError ||
    form.previewUrls.some((r) => !!testingUrlError(r)) ||
    form.testCredentials.some((r) => !!credentialError(r));

  function setField(key: keyof Form, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function setUrlRow(index: number, patch: Partial<TestingUrl>) {
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

  function setCredRow(index: number, patch: Partial<TestCredential>) {
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

  function save() {
    if (!dirty || hasErrors) return;
    // cm:guard the stored blob is spread FIRST at every level the tab edits, because the server's
    // `environments` patch REPLACES the column outright — nothing merges, at any depth. A save that
    // rebuilt the object from the form alone would delete every key this screen does not render:
    // `live.apiUrl`, and any deploy knob a later version adds through the catchall.
    const stored = (project.environments ?? {}) as Record<string, unknown>;
    const storedLive = (stored.live ?? {}) as Record<string, unknown>;
    const storedPreview = (stored.preview ?? {}) as Record<string, unknown>;
    const environments: EnvironmentsConfig = {
      ...stored,
      live: {
        ...storedLive,
        url: trimmedOrNull(form.liveUrl),
        commitUrl: trimmedOrNull(form.liveCommitUrl),
        commitPath: trimmedOrNull(form.liveCommitPath),
      },
      preview: previewDeclared(form)
        ? {
            ...storedPreview,
            url: trimmedOrNull(form.previewUrl),
            apiUrl: trimmedOrNull(form.previewApiUrl),
            urls: keptUrlRows(form.previewUrls),
          }
        : null,
      testCredentials: keptCredentials(form.testCredentials),
      limits: trimmedOrNull(form.limits),
    };
    update.mutate({ environments });
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardContent>
          <h2 className="fg-h3 mb-1">What this environment does not have</h2>
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
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <h2 className="fg-h3 mb-1">Live</h2>
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
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <h2 className="fg-h3 mb-1">Preview</h2>
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
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <h2 className="fg-h3 mb-1">Testing URLs</h2>
          <p className="fg-caption mb-4 text-muted">
            Named links QA opens while verifying the preview side — admin panels, mailbox,
            dashboards.
          </p>
          {form.previewUrls.length === 0 ? (
            <p className="fg-body-sm text-muted">No testing URLs.</p>
          ) : (
            <ul className="space-y-3">
              {form.previewUrls.map((row, i) => {
                const err = testingUrlError(row);
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
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <h2 className="fg-h3 mb-1">Test credentials</h2>
          <p className="fg-caption mb-4 text-muted">
            Login accounts QA uses against either side. Passwords are masked by default.
          </p>
          {form.testCredentials.length === 0 ? (
            <p className="fg-body-sm text-muted">No test credentials.</p>
          ) : (
            <ul className="space-y-3">
              {form.testCredentials.map((row, i) => {
                const err = credentialError(row);
                return (
                  <li key={i} className="rounded-md border border-line p-3">
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
        </CardContent>
      </Card>

      {canEdit && (
        <div>
          <Button
            variant="primary"
            loading={update.isPending}
            disabled={!dirty || hasErrors}
            onClick={save}
            className="min-h-11"
          >
            Save testing config
          </Button>
        </div>
      )}
    </div>
  );
}
