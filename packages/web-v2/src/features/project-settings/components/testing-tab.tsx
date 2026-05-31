"use client";

// Project settings → Testing. View/edit the project's `previewDeploy` blob:
// staging endpoints + the testing URLs and credentials QA uses against a
// deployment. Persisted via PATCH /api/projects/:id (owner-gated server-side,
// validated by `previewDeployPatchSchema`). Mirrors the basics-tab dirty/save
// pattern and the labels-tab add/remove-row UI. Passwords are masked by default
// with a per-row reveal toggle; values are never logged.
import { useEffect, useMemo, useState } from "react";
import { Button, Card, CardContent, Field, IconButton, Input } from "@/design";
import type { ProjectDetail } from "@/features/projects/types";
import { useUpdateProject } from "../hooks";
import type { PreviewDeployConfig, TestCredential, TestingUrl } from "../types";

// Backend caps (see `testingUrlSchema` / `testCredentialSchema` in core).
const MAX_ROWS = 50;
const LABEL_MAX = 80;
const URL_MAX = 500;
const USERNAME_MAX = 200;
const PASSWORD_MAX = 500;

interface Form {
  stagingUrl: string;
  stagingApiUrl: string;
  testingUrls: TestingUrl[];
  testCredentials: TestCredential[];
}

/** Read the stored jsonb blob into editable form state (defensive — jsonb is
 *  typed `unknown`, so coerce every field and tolerate partial/legacy shapes). */
function parse(raw: unknown): Form {
  const pd = (raw ?? {}) as PreviewDeployConfig;
  return {
    stagingUrl: typeof pd.stagingUrl === "string" ? pd.stagingUrl : "",
    stagingApiUrl: typeof pd.stagingApiUrl === "string" ? pd.stagingApiUrl : "",
    testingUrls: Array.isArray(pd.testingUrls)
      ? pd.testingUrls.map((u) => ({
          label: String((u as TestingUrl)?.label ?? ""),
          url: String((u as TestingUrl)?.url ?? ""),
        }))
      : [],
    testCredentials: Array.isArray(pd.testCredentials)
      ? pd.testCredentials.map((c) => ({
          label: String((c as TestCredential)?.label ?? ""),
          username: String((c as TestCredential)?.username ?? ""),
          password: String((c as TestCredential)?.password ?? ""),
        }))
      : [],
  };
}

function isValidUrl(value: string): boolean {
  try {
    // eslint-disable-next-line no-new -- validation only
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/** Canonical JSON of the known fields, used for dirty detection. Empty staging
 *  fields normalize to null; blank/partial rows are dropped — matching what the
 *  save path actually sends, so a freshly-loaded form reads as not-dirty. */
function canonical(form: Form): string {
  return JSON.stringify({
    stagingUrl: form.stagingUrl.trim() === "" ? null : form.stagingUrl.trim(),
    stagingApiUrl: form.stagingApiUrl.trim() === "" ? null : form.stagingApiUrl.trim(),
    testingUrls: form.testingUrls
      .filter((u) => u.label.trim() !== "" && u.url.trim() !== "")
      .map((u) => ({ label: u.label.trim(), url: u.url.trim() })),
    testCredentials: form.testCredentials
      .filter((c) => c.label.trim() !== "")
      .map((c) => ({ label: c.label.trim(), username: c.username.trim(), password: c.password })),
  });
}

export function TestingTab({ project, canEdit }: { project: ProjectDetail; canEdit: boolean }) {
  const update = useUpdateProject(project.id);

  const [form, setForm] = useState<Form>(() => parse(project.previewDeploy));
  const [revealed, setRevealed] = useState<Set<number>>(new Set());

  // Re-hydrate when the project refetches (e.g. after a save invalidates it).
  useEffect(() => {
    setForm(parse(project.previewDeploy));
    setRevealed(new Set());
  }, [project.previewDeploy]);

  const original = useMemo(() => canonical(parse(project.previewDeploy)), [project.previewDeploy]);
  const dirty = canonical(form) !== original;

  // Validation — block save on malformed URLs or partially-filled rows.
  const stagingUrlError =
    form.stagingUrl.trim() !== "" && !isValidUrl(form.stagingUrl.trim())
      ? "Enter a valid URL (including http(s)://)."
      : undefined;
  const stagingApiUrlError =
    form.stagingApiUrl.trim() !== "" && !isValidUrl(form.stagingApiUrl.trim())
      ? "Enter a valid URL (including http(s)://)."
      : undefined;

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
    !!stagingUrlError ||
    !!stagingApiUrlError ||
    form.testingUrls.some((r) => !!testingUrlError(r)) ||
    form.testCredentials.some((r) => !!credentialError(r));

  function setStaging(key: "stagingUrl" | "stagingApiUrl", value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function setUrlRow(index: number, patch: Partial<TestingUrl>) {
    setForm((f) => ({
      ...f,
      testingUrls: f.testingUrls.map((r, i) => (i === index ? { ...r, ...patch } : r)),
    }));
  }
  function addUrlRow() {
    setForm((f) =>
      f.testingUrls.length >= MAX_ROWS
        ? f
        : { ...f, testingUrls: [...f.testingUrls, { label: "", url: "" }] },
    );
  }
  function removeUrlRow(index: number) {
    setForm((f) => ({ ...f, testingUrls: f.testingUrls.filter((_, i) => i !== index) }));
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
    // Preserve unknown keys the server's `.catchall` round-trips (e.g. future
    // deploy knobs the FE doesn't surface) by spreading the stored blob first.
    const stored = (project.previewDeploy ?? {}) as Record<string, unknown>;
    const previewDeploy: PreviewDeployConfig = {
      ...stored,
      stagingUrl: form.stagingUrl.trim() === "" ? null : form.stagingUrl.trim(),
      stagingApiUrl: form.stagingApiUrl.trim() === "" ? null : form.stagingApiUrl.trim(),
      testingUrls: form.testingUrls
        .filter((u) => u.label.trim() !== "" && u.url.trim() !== "")
        .map((u) => ({ label: u.label.trim(), url: u.url.trim() })),
      testCredentials: form.testCredentials
        .filter((c) => c.label.trim() !== "")
        .map((c) => ({ label: c.label.trim(), username: c.username.trim(), password: c.password })),
    };
    update.mutate({ previewDeploy });
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardContent>
          <h2 className="fg-h3 mb-1">Staging</h2>
          <p className="fg-caption mb-4 text-muted">
            Where this project is deployed for QA. Used by the testing pipeline.
          </p>
          <div className="space-y-4">
            <Field label="Staging URL" hint="Frontend URL, e.g. https://staging.example.com" error={stagingUrlError}>
              <Input
                value={form.stagingUrl}
                onChange={(e) => setStaging("stagingUrl", e.target.value)}
                disabled={!canEdit}
                placeholder="https://staging.example.com"
                maxLength={URL_MAX}
                inputMode="url"
              />
            </Field>
            <Field label="Staging API URL" hint="Backend/API base URL." error={stagingApiUrlError}>
              <Input
                value={form.stagingApiUrl}
                onChange={(e) => setStaging("stagingApiUrl", e.target.value)}
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
            Named links QA opens while verifying — admin panels, mailbox, dashboards.
          </p>
          {form.testingUrls.length === 0 ? (
            <p className="fg-body-sm text-muted">No testing URLs.</p>
          ) : (
            <ul className="space-y-3">
              {form.testingUrls.map((row, i) => {
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
                disabled={form.testingUrls.length >= MAX_ROWS}
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
            Login accounts QA uses on staging. Passwords are masked by default.
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
