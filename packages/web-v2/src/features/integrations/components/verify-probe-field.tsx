"use client";

// The verify probe of a live deploy binding: what a release reads to learn the commit production
// serves. Round 1 of ISS-1339 moved it off the project's environments and onto the binding, which
// left the web app with no place to declare it; this is that place. Provider-agnostic the way
// `BindingReleaseRunnerField` is, because `verify` is a binding-tier key for every provider a
// release reads a probe from. `config` is the merged connection+binding view and `bindingConfig`
// this project's own, which is how the section says WHICH tier the probe in force came from.

import { useEffect, useId, useRef, useState } from "react";
import {
  Button,
  CardTitle,
  ConfirmDialog,
  Field,
  IconButton,
  Input,
  useUnsavedChanges,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useIntegrationsList, useUpdateProviderIntegration } from "../hooks";
import type { IntegrationSummary } from "../types";
import { labelDecidesFor } from "./release-runner-field";

/** The config key itself, so no screen spells it differently from the API. */
export const VERIFY_KEY = "verify";

export const VERIFY_PROBE_HEADING = "Verify probe";

/** The section's id, and the `?field=` a link that lands on it carries. */
export const VERIFY_PROBE_SECTION = "verify-probe";

export const REMOVE_ALL_PROBES = "Remove all probes";

/** `verify.probes` caps at ten in core's `releaseChannelFields`. */
const MAX_PROBES = 10;

const FIELD_ERROR = { color: "var(--red-600)" } as const;

export interface ProbeRow {
  url: string;
  commitPath: string;
}

/** The probes a stored `verify` declares, read the way core's `parseVerifyConfig` reads them: a
 *  probe with no url is not one, and a block with none is not a declaration. */
export function declaredProbes(raw: unknown): ProbeRow[] {
  if (typeof raw !== "object" || raw === null) return [];
  const probes = (raw as { probes?: unknown }).probes;
  if (!Array.isArray(probes)) return [];
  return probes
    .filter((p): p is Record<string, unknown> => typeof p === "object" && p !== null)
    .map((p) => ({
      url: typeof p.url === "string" ? p.url : "",
      commitPath: typeof p.commitPath === "string" ? p.commitPath : "",
    }))
    .filter((p) => p.url.length > 0);
}

function isAbsoluteHttp(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** Whether a release can read this binding's probe: one probe at least, each url an address a
 *  request can be made to. A stored block that fails this is a declaration to correct. */
export function probeIsUsable(raw: unknown): boolean {
  const probes = declaredProbes(raw);
  return probes.length > 0 && probes.every((p) => isAbsoluteHttp(p.url));
}

/** Why one row cannot be saved, said with the number the row has when the sentence is drawn. */
export type RowFault = "no-url" | "not-http";

export function rowFaultSentence(fault: RowFault, n: number): string {
  return fault === "no-url"
    ? `Probe ${n} has a commit field and no URL. Type its URL, or clear the row.`
    : `Probe ${n}'s URL is not an http or https address, such as https://api.example.com/version.`;
}

const NOTHING_TYPED = "Type the address the live deployment answers its commit on, or remove the probe.";

/** What a save would send for these rows, or what refuses it: each row's fault by its position, or
 *  that nothing was typed at all. */
export function probeWrite(
  rows: readonly ProbeRow[],
  stableReads: unknown,
):
  | { ok: true; verify: Record<string, unknown> }
  | { ok: false; faults: (RowFault | null)[]; nothingTyped: boolean } {
  const trimmed = rows.map((row) => ({ url: row.url.trim(), commitPath: row.commitPath.trim() }));
  const typed = trimmed.filter((row) => row.url !== "" || row.commitPath !== "");
  if (typed.length === 0) return { ok: false, faults: rows.map(() => null), nothingTyped: true };
  const faults = trimmed.map((row): RowFault | null =>
    row.url === "" ? (row.commitPath === "" ? null : "no-url") : isAbsoluteHttp(row.url) ? null : "not-http",
  );
  if (faults.some((f) => f !== null)) return { ok: false, faults, nothingTyped: false };
  return {
    ok: true,
    verify: {
      probes: typed.map((row) => ({ url: row.url, ...(row.commitPath ? { commitPath: row.commitPath } : {}) })),
      ...(typeof stableReads === "number" ? { stableReads } : {}),
    },
  };
}

/** What the project's other live deploy bindings declare: a probe a release reads, a block it
 *  refuses, or nothing; `null` until they are read. */
export type OtherProbes = "usable" | "unusable" | "none" | null;

/** What a release records once this binding declares no probe. */
export function afterRemovalSentence(others: OtherProbes): string {
  switch (others) {
    case null:
      return "A release then reads no commit from this binding, and closes unverified unless another live binding declares a probe.";
    case "unusable":
      return "Another live binding declares a probe a release cannot read, so a release is refused until that probe is corrected.";
    case "usable":
      return "A release then reads only the probes the project's other live bindings declare.";
    case "none":
      return "No other live binding declares a probe, so a release then closes unverified.";
  }
}

function storedKey(raw: unknown, key: string): unknown {
  return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>)[key] : undefined;
}

function Reading({ declared, inherited, unusable }: { declared: ProbeRow[]; inherited: boolean; unusable: boolean }) {
  if (declared.length === 0) {
    return (
      <p className="fg-body-sm text-muted">
        {unusable
          ? "A verify block is stored here, but it names no probe a release can read. Correct it below."
          : "None declared — a release reads nothing on this binding. Where no live binding declares one, the release closes unverified."}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <p className="fg-body-sm text-muted">
        {inherited
          ? "Inherited from the shared connection behind this binding. Saving here declares this project's own, which a release reads instead."
          : `A release reads ${declared.length === 1 ? "this probe" : "these probes"} to learn the commit production serves.`}
      </p>
      <ul className="divide-y divide-line border-y border-line" aria-label="Declared probes">
        {declared.map((p) => (
          <li key={`${p.url}\u0000${p.commitPath}`} className="fg-body-sm py-1.5">
            <span className="font-mono break-all">{p.url}</span>
            <span className="text-muted">
              {" "}
              — commit read from{" "}
              {p.commitPath ? <span className="font-mono">{p.commitPath}</span> : "the whole answer"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// A block a release refuses blocks it whatever the others declare (`unreadableProbeBlockers`).
function useOtherLiveProbe(projectId: string, bindingId: string): OtherProbes {
  const list = useIntegrationsList(projectId);
  if (!list.data) return null;
  const declared = list.data.items
    .filter((b) => b.id !== bindingId && b.role === "deploy" && b.stages.includes("live") && b.active !== false)
    .map((b) => b.config?.[VERIFY_KEY])
    .filter((v) => v !== undefined && v !== null);
  if (declared.some((v) => !probeIsUsable(v))) return "unusable";
  return declared.length > 0 ? "usable" : "none";
}

/**
 * The binding tier, in the project's own Integrations drawer, drawn only for a live deploy binding
 * because only a release reads it. A save sends `config.verify` whole — the probes and a stored
 * `stableReads` — and Remove all probes sends `null`, which the binding PATCH's `withdrawNulls`
 * removes, once a person has confirmed it.
 */
export function BindingVerifyProbeField({
  projectId,
  binding,
  canEdit,
  focus = false,
  onDirtyChange,
}: {
  projectId: string;
  binding: Pick<IntegrationSummary, "id" | "role" | "stages" | "config" | "bindingConfig">;
  canEdit: boolean;
  /** Arrived from a link that names this section: scroll to it and put the cursor in its URL. */
  focus?: boolean;
  /** Told whenever the rows start or stop differing from what is stored. */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const update = useUpdateProviderIntegration(projectId);
  const [failure, setFailure] = useState<string | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  // One write per press: `isPending` reaches the buttons a render later than a second click can.
  const inFlight = useRef(false);
  const decides = labelDecidesFor(binding);
  const otherDeclares = useOtherLiveProbe(projectId, binding.id);

  // After the drawer around it has taken focus for itself, which it does once it opens.
  useEffect(() => {
    if (!focus || !decides) return;
    const timer = window.setTimeout(() => {
      sectionRef.current?.scrollIntoView?.({ block: "start" });
      sectionRef.current
        ?.querySelector<HTMLInputElement>("input[data-probe-url]")
        ?.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [focus, decides]);

  if (!decides) return null;

  const own = binding.bindingConfig?.[VERIFY_KEY];
  const effective = binding.config?.[VERIFY_KEY];
  const declared = declaredProbes(effective);
  const ownDeclared = own !== undefined && own !== null;
  const present = effective !== undefined && effective !== null;

  const write = (verify: Record<string, unknown> | null, then?: () => void) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setFailure(null);
    update.mutate(
      { id: binding.id, body: { config: { [VERIFY_KEY]: verify } } },
      {
        onSuccess: () => then?.(),
        onError: (err) => setFailure(formatApiError(err)),
        onSettled: () => {
          inFlight.current = false;
        },
      },
    );
  };

  return (
    <section ref={sectionRef} id={VERIFY_PROBE_SECTION} className="flex scroll-mt-4 flex-col gap-2">
      <CardTitle>{VERIFY_PROBE_HEADING}</CardTitle>
      <Reading
        declared={declared}
        inherited={!ownDeclared && declared.length > 0}
        unusable={present && declared.length === 0}
      />
      {canEdit ? (
        <Editor
          // Re-seeds the rows when a save lands or the read arrives after the mount.
          key={JSON.stringify(effective ?? null)}
          seed={declared}
          stableReads={storedKey(effective, "stableReads")}
          dropsTimeout={storedKey(effective, "timeoutSeconds") !== undefined}
          removable={ownDeclared ? declaredProbes(own).length : null}
          ownStableReads={storedKey(own, "stableReads")}
          otherDeclares={otherDeclares}
          busy={update.isPending}
          onSave={(verify) => write(verify)}
          onRemoveAll={(then) => write(null, then)}
          onDirtyChange={onDirtyChange}
        />
      ) : (
        <p className="fg-body-sm text-subtle">Only a project admin can change this.</p>
      )}
      {failure && (
        <p role="alert" className="fg-body-sm" style={FIELD_ERROR}>
          {failure}
        </p>
      )}
    </section>
  );
}

interface EditRow extends ProbeRow {
  /** Who the row is, so its error and its focus follow it when a row above it goes. */
  id: number;
  fault: RowFault | null;
}

/** The rows as a save would read them, so an edit that changes nothing a save sends is not one. */
function comparable(rows: readonly ProbeRow[]): string {
  return JSON.stringify(
    rows
      .map((r) => [r.url.trim(), r.commitPath.trim()])
      .filter(([url, commitPath]) => url !== "" || commitPath !== ""),
  );
}

function RemoveAllConfirm({
  count,
  stableReads,
  otherDeclares,
  busy,
  open,
  onConfirm,
  onClose,
}: {
  count: number;
  stableReads: unknown;
  otherDeclares: OtherProbes;
  busy: boolean;
  open: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  // A stored block naming no probe a release can read is still a declaration to remove.
  const what =
    count === 0
      ? "the verify block stored on this binding, which names no probe a release can read"
      : count === 1
        ? "the 1 probe this binding declares"
        : `all ${count} probes this binding declares`;
  return (
    <ConfirmDialog
      open={open}
      title={count === 1 ? "Remove the probe?" : count === 0 ? "Remove the verify block?" : `Remove all ${count} probes?`}
      message={
        <>
          {`This removes ${what}. ${afterRemovalSentence(otherDeclares)}`}
          {typeof stableReads === "number" &&
            ` The stored stableReads (${stableReads}) is removed with them: it only applies while a probe is declared.`}
        </>
      }
      confirmLabel={REMOVE_ALL_PROBES}
      cancelLabel="Keep them"
      tone="danger"
      loading={busy}
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}

function Editor({
  seed,
  stableReads,
  dropsTimeout,
  removable,
  ownStableReads,
  otherDeclares,
  busy,
  onSave,
  onRemoveAll,
  onDirtyChange,
}: {
  seed: ProbeRow[];
  stableReads: unknown;
  dropsTimeout: boolean;
  /** How many probes this binding declares of its own, which is what removing them takes; `null`
   *  where it declares none, so there is nothing here to remove. */
  removable: number | null;
  ownStableReads: unknown;
  otherDeclares: OtherProbes;
  busy: boolean;
  onSave: (verify: Record<string, unknown>) => void;
  onRemoveAll: (then: () => void) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const nextId = useRef(0);
  const fresh = (row: ProbeRow): EditRow => ({ ...row, id: nextId.current++, fault: null });
  const [rows, setRows] = useState<EditRow[]>(() =>
    (seed.length > 0 ? seed : [{ url: "", commitPath: "" }]).map(fresh),
  );
  const [nothingTyped, setNothingTyped] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [focusRow, setFocusRow] = useState<number | null>(null);
  const idBase = useId();
  const urlId = (row: EditRow) => `${idBase}-probe-${row.id}-url`;

  const dirty = comparable(rows) !== comparable(seed);
  useUnsavedChanges(dirty);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  useEffect(() => {
    if (focusRow === null) return;
    document.getElementById(`${idBase}-probe-${focusRow}-url`)?.focus();
    setFocusRow(null);
  }, [focusRow, idBase]);

  const setRow = (id: number, patch: Partial<ProbeRow>) => {
    setNothingTyped(false);
    setRows((cur) => cur.map((row) => (row.id === id ? { ...row, ...patch, fault: null } : row)));
  };

  const removeRow = (id: number) => {
    const at = rows.findIndex((row) => row.id === id);
    const left = rows.filter((row) => row.id !== id);
    setRows(left);
    // Onto the row that took its place, or the one above where it was last.
    const landing = left[Math.min(at, left.length - 1)];
    if (landing) setFocusRow(landing.id);
  };

  const save = () => {
    const answer = probeWrite(rows, stableReads);
    if (!answer.ok) {
      setNothingTyped(answer.nothingTyped);
      setRows((cur) => cur.map((row, i) => ({ ...row, fault: answer.faults[i] ?? null })));
      return;
    }
    setNothingTyped(false);
    onSave(answer.verify);
  };

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-3">
        {rows.map((row, i) => (
          <li key={row.id} className="flex flex-col gap-2 sm:flex-row sm:items-start">
            <div className="min-w-0 flex-1">
              <Field
                label={`Probe ${i + 1} URL`}
                htmlFor={urlId(row)}
                error={row.fault ? rowFaultSentence(row.fault, i + 1) : undefined}
              >
                <Input
                  value={row.url}
                  onChange={(e) => setRow(row.id, { url: e.target.value })}
                  inputMode="url"
                  maxLength={500}
                  disabled={busy}
                  data-probe-url=""
                />
              </Field>
            </div>
            <div className="flex items-end gap-2 sm:w-52">
              <div className="min-w-0 flex-1">
                <Field label={`Probe ${i + 1} commit field`}>
                  <Input
                    value={row.commitPath}
                    onChange={(e) => setRow(row.id, { commitPath: e.target.value })}
                    maxLength={200}
                    disabled={busy}
                  />
                </Field>
              </div>
              {rows.length > 1 && (
                <IconButton
                  icon="trash"
                  aria-label={`Remove probe ${i + 1}`}
                  disabled={busy}
                  onClick={() => removeRow(row.id)}
                />
              )}
            </div>
          </li>
        ))}
      </ul>
      <p className="fg-caption text-subtle">
        The URL answers with the commit the live deployment is serving, such as{" "}
        <span className="font-mono">https://api.example.com/version</span>. The commit field is where that
        commit sits in its JSON answer, as a dot path such as <span className="font-mono">data.commit</span>.
        Left blank, the whole answer is read as the commit.
      </p>
      {dropsTimeout && (
        <p className="fg-caption text-subtle">
          The stored probe also carries <span className="font-mono">timeoutSeconds</span>, which no release
          reads any more. Saving here leaves it out.
        </p>
      )}
      {nothingTyped && (
        <p role="alert" className="fg-body-sm" style={FIELD_ERROR}>
          {NOTHING_TYPED}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" loading={busy} disabled={busy} onClick={save}>
          Save probe
        </Button>
        {rows.length < MAX_PROBES && (
          <Button
            variant="ghost"
            size="sm"
            icon="plus"
            disabled={busy}
            onClick={() => {
              const row = fresh({ url: "", commitPath: "" });
              setRows((cur) => [...cur, row]);
              setFocusRow(row.id);
            }}
          >
            Add another probe
          </Button>
        )}
        {removable !== null && (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(true)}>
            {REMOVE_ALL_PROBES}
          </Button>
        )}
      </div>
      <RemoveAllConfirm
        open={confirming}
        count={removable ?? 0}
        stableReads={ownStableReads}
        otherDeclares={otherDeclares}
        busy={busy}
        onConfirm={() => onRemoveAll(() => setConfirming(false))}
        onClose={() => setConfirming(false)}
      />
    </div>
  );
}
