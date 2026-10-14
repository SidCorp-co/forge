"use client";

import { Button, Field, Input, NativeSelect, Textarea } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useMemo } from "react";
import { useSentryProjects } from "../../hooks";
import type { SentryProject, SentryTarget } from "../../types";

/** Editable Sentry target row — strings only so inputs stay controlled. `manual` is the form's own
 *  note that the slugs are typed rather than picked; it is never sent. */
export interface TargetRow {
  label: string;
  organizationSlug: string;
  projectSlug: string;
  environment: string;
  notes: string;
  manual?: boolean;
}

export const emptyRow = (): TargetRow => ({
  label: "",
  organizationSlug: "",
  projectSlug: "",
  environment: "",
  notes: "",
});

/** Seed the editable rows from this project's stored targets, else one blank starter row. */
export function initialTargets(targets: SentryTarget[] | undefined): TargetRow[] {
  if (Array.isArray(targets) && targets.length > 0) {
    return targets.map((t) => ({
      label: t.label ?? "",
      organizationSlug: t.organizationSlug ?? "",
      projectSlug: t.projectSlug ?? "",
      environment: t.environment ?? "",
      notes: t.notes ?? "",
    }));
  }
  return [emptyRow()];
}

/** A row carrying any data but no label — must be fixed before save. */
export function rowInvalid(t: TargetRow): boolean {
  const hasContent =
    t.organizationSlug.trim() || t.projectSlug.trim() || t.environment.trim() || t.notes.trim();
  return !t.label.trim() && Boolean(hasContent);
}

/** A row with nothing at all — silently dropped, never persisted. */
function rowBlank(t: TargetRow): boolean {
  return (
    !t.label.trim() &&
    !t.organizationSlug.trim() &&
    !t.projectSlug.trim() &&
    !t.environment.trim() &&
    !t.notes.trim()
  );
}

/** The payload's `targets`: blank rows dropped, values trimmed, empties omitted. */
export function toTargets(rows: TargetRow[]): SentryTarget[] {
  return rows
    .filter((t) => !rowBlank(t))
    .map((t) => {
      const out: SentryTarget = { label: t.label.trim() };
      if (t.organizationSlug.trim()) out.organizationSlug = t.organizationSlug.trim();
      if (t.projectSlug.trim()) out.projectSlug = t.projectSlug.trim();
      if (t.environment.trim()) out.environment = t.environment.trim();
      if (t.notes.trim()) out.notes = t.notes.trim();
      return out;
    });
}

const CUSTOM = "__custom__";
const keyOf = (p: { organizationSlug: string; slug: string }) => `${p.organizationSlug}/${p.slug}`;

/**
 * ISS-1380 — this project's Sentry targets, picked from the organization's Sentry projects.
 *
 * The list comes through the token the connection already holds (`integrationId`), or through the
 * host and token typed on the create form once the person asks for it. Where the list cannot be read
 * the form says why and keeps free-text slugs, so a Sentry that is down never blocks a save.
 */
export function SentryTargetsField({
  projectId,
  integrationId,
  host,
  authToken,
  loading,
  credentialUnsaved,
  listRequested,
  onRequestList,
  rows,
  onChange,
}: {
  projectId: string;
  integrationId: string | undefined;
  host: string;
  authToken: string;
  /** The project's integrations are still being read, so whether one exists is not yet known. */
  loading: boolean;
  /** The host or token above was edited and not saved: the list is still read with the saved ones. */
  credentialUnsaved: boolean;
  /** Before an integration exists the list is read only once the person asks for it. */
  listRequested: boolean;
  onRequestList: () => void;
  rows: TargetRow[];
  onChange: (next: TargetRow[]) => void;
}) {
  const typedCredential = host.trim() && authToken.trim().length >= 8;
  const auth = integrationId
    ? { integrationId }
    : listRequested && typedCredential
      ? { host: host.trim(), authToken: authToken.trim() }
      : null;
  const listing = useSentryProjects(projectId, auth);
  const projects: SentryProject[] = listing.data?.projects ?? [];
  const known = useMemo(() => new Set(projects.map(keyOf)), [projects]);
  const options = useMemo(
    () => [
      { value: "", label: "Pick a Sentry project…" },
      ...projects.map((p) => ({
        value: keyOf(p),
        label: `${p.name ?? p.slug} — ${keyOf(p)}${p.platform ? ` · ${p.platform}` : ""}`,
      })),
      { value: CUSTOM, label: "Another project — type its slugs" },
    ],
    [projects],
  );

  const update = (index: number, patch: Partial<TargetRow>) =>
    onChange(rows.map((t, i) => (i === index ? { ...t, ...patch } : t)));

  function pick(index: number, value: string) {
    if (value === CUSTOM) return update(index, { manual: true });
    const chosen = projects.find((p) => keyOf(p) === value);
    if (!chosen) return update(index, { organizationSlug: "", projectSlug: "", manual: false });
    const row = rows[index];
    update(index, {
      organizationSlug: chosen.organizationSlug,
      projectSlug: chosen.slug,
      manual: false,
      ...(row && !row.label.trim() ? { label: chosen.slug } : {}),
    });
  }

  const listed = projects.length > 0;
  function statusLine(): string | null {
    if (listing.isPending && auth) return "Reading the Sentry projects this token can see…";
    if (listing.isError) {
      return `Could not list Sentry projects: ${formatApiError(listing.error)} Type the organization and project slugs by hand.`;
    }
    if (loading) return null;
    if (integrationId && credentialUnsaved) {
      return "This list is read with the host and token already saved. Save your changes to the host or token to read it with the new ones.";
    }
    if (!integrationId && !auth) {
      return "Add the host and token above, then load the project list — or type the slugs by hand.";
    }
    if (listing.data && !listed) {
      return "Sentry lists no project for this token. Type the organization and project slugs by hand.";
    }
    if (listing.data?.truncated) {
      return "Sentry holds more projects than this list shows. A project that is not listed can be typed by hand.";
    }
    return null;
  }
  const status = statusLine();

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <span className="fg-label text-muted">Sentry projects · this project</span>
        <div className="flex items-center gap-2">
          {!integrationId && (
            <Button
              variant="secondary"
              onClick={() => (listRequested ? listing.refetch() : onRequestList())}
              disabled={!typedCredential || listing.isFetching}
            >
              Load projects from Sentry
            </Button>
          )}
          <Button variant="secondary" icon="plus" onClick={() => onChange([...rows, emptyRow()])}>
            Add project
          </Button>
        </div>
      </div>
      <p className="fg-body-sm text-muted">
        The Sentry projects this project&apos;s agents may read. They are stored with this project
        only: another project bound to the same connection keeps its own list and cannot name these.
      </p>
      {status && (
        <p className="fg-body-sm text-muted" role="status">
          {status}
        </p>
      )}

      {rows.length === 0 ? (
        <p className="fg-body-sm text-muted border-y border-dashed border-subtle py-4 text-center">
          No Sentry projects registered yet. Add one (e.g. “Backend” → org/project) so agents know
          which Sentry project to query.
        </p>
      ) : (
        rows.map((t, i) => {
          const picked = keyOf({ organizationSlug: t.organizationSlug, slug: t.projectSlug });
          const typed = !listed || t.manual || (picked !== "/" && !known.has(picked));
          return (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: rows have no stable id; order is the identity
              key={i}
              className="flex flex-col gap-3 border-t border-subtle pt-3"
            >
              <div className="flex items-start justify-between gap-2">
                <span className="fg-label text-muted">Project {i + 1}</span>
                <Button
                  variant="ghost"
                  icon="trash"
                  onClick={() => onChange(rows.filter((_, k) => k !== i))}
                  aria-label={`Remove project ${i + 1}`}
                />
              </div>
              <Field
                label="Label"
                hint="A name the agent recognizes, e.g. Backend prod."
                required
                error={rowInvalid(t) ? "A label is required for this project." : undefined}
              >
                <Input
                  value={t.label}
                  onChange={(e) => update(i, { label: e.target.value })}
                  placeholder="Backend prod"
                />
              </Field>
              {listed && !typed && (
                <Field label="Sentry project" hint="Fills the organization and project slugs.">
                  <NativeSelect
                    aria-label={`Sentry project for target ${i + 1}`}
                    value={picked === "/" ? "" : picked}
                    options={options}
                    onChange={(e) => pick(i, e.target.value)}
                  />
                </Field>
              )}
              {listed && typed && (
                <div>
                  <Button
                    variant="ghost"
                    onClick={() =>
                      // A slug pair the list does not hold cannot be shown as a pick, so it is cleared
                      // here, by the person asking to pick instead; label, environment and notes stay.
                      update(i, {
                        manual: false,
                        ...(picked !== "/" && !known.has(picked)
                          ? { organizationSlug: "", projectSlug: "" }
                          : {}),
                      })
                    }
                  >
                    Pick from the list instead
                  </Button>
                </div>
              )}
              {typed && (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Organization slug" hint="The Sentry organization this project is under.">
                    <Input
                      value={t.organizationSlug}
                      onChange={(e) => update(i, { organizationSlug: e.target.value })}
                      placeholder="canawan"
                    />
                  </Field>
                  <Field label="Project slug" hint="Optional — leave empty to cover the whole organization.">
                    <Input
                      value={t.projectSlug}
                      onChange={(e) => update(i, { projectSlug: e.target.value })}
                      placeholder="(optional)"
                    />
                  </Field>
                </div>
              )}
              <Field
                label="Environment"
                hint="Optional label only (e.g. prod, staging) — not a separate token."
              >
                <Input
                  value={t.environment}
                  onChange={(e) => update(i, { environment: e.target.value })}
                  placeholder="(optional)"
                />
              </Field>
              <Field
                label="Notes"
                hint="Optional free text shared with agents (e.g. what lives in this project)."
              >
                <Textarea
                  value={t.notes}
                  onChange={(e) => update(i, { notes: e.target.value })}
                  rows={2}
                  placeholder="(optional)"
                />
              </Field>
            </div>
          );
        })
      )}
    </div>
  );
}
