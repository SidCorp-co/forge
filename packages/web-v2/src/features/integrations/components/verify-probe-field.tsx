"use client";

// The verify probe of a live deploy binding: what a release reads to learn the commit production
// serves. Round 1 of ISS-1339 moved it off the project's environments and onto the binding, which
// left the web app with no place to declare it; this is that place. Provider-agnostic the way
// `BindingReleaseRunnerField` is, because `verify` is a binding-tier key for every provider a
// release reads a probe from. `config` is the merged connection+binding view and `bindingConfig`
// this project's own, which is how the section says WHICH tier the probe in force came from.

import { useEffect, useRef, useState } from "react";
import { Button, CardTitle, IconButton, Input } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useUpdateProviderIntegration } from "../hooks";
import type { IntegrationSummary } from "../types";
import { labelDecidesFor } from "./release-runner-field";

/** The config key itself, so no screen spells it differently from the API. */
export const VERIFY_KEY = "verify";

export const VERIFY_PROBE_HEADING = "Verify probe";

/** The section's id, and the `?field=` a link that lands on it carries. */
export const VERIFY_PROBE_SECTION = "verify-probe";

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

/** What a save would send for these rows, or the sentence that refuses it, each row by its number. */
export function probeWrite(
  rows: readonly ProbeRow[],
  stableReads: unknown,
): { ok: true; verify: Record<string, unknown> } | { ok: false; problems: string[] } {
  const typed = rows
    .map((row, i) => ({ n: i + 1, url: row.url.trim(), commitPath: row.commitPath.trim() }))
    .filter((row) => row.url !== "" || row.commitPath !== "");
  if (typed.length === 0) {
    return {
      ok: false,
      problems: ["Type the address the live deployment answers its commit on, or remove the probe."],
    };
  }
  const problems = typed.flatMap((row) =>
    row.url === ""
      ? [`Probe ${row.n} has a commit field and no URL. Type its URL, or clear the row.`]
      : isAbsoluteHttp(row.url)
        ? []
        : [`Probe ${row.n}'s URL is not an http or https address, such as https://api.example.com/version.`],
  );
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    verify: {
      probes: typed.map((row) => ({ url: row.url, ...(row.commitPath ? { commitPath: row.commitPath } : {}) })),
      ...(typeof stableReads === "number" ? { stableReads } : {}),
    },
  };
}

/** The URL input's accessible name, which is also how a link that lands here finds it. */
const probeUrlLabel = (i: number) => `Probe ${i + 1} URL`;

function seedRows(probes: ProbeRow[]): ProbeRow[] {
  return probes.length > 0 ? probes.map((p) => ({ ...p })) : [{ url: "", commitPath: "" }];
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

/**
 * The binding tier, in the project's own Integrations drawer, drawn only for a live deploy binding
 * because only a release reads it. A save sends `config.verify` whole — the probes and a stored
 * `stableReads` — and Remove sends `null`, which the binding PATCH's `withdrawNulls` removes.
 */
export function BindingVerifyProbeField({
  projectId,
  binding,
  canEdit,
  focus = false,
}: {
  projectId: string;
  binding: Pick<IntegrationSummary, "id" | "role" | "stages" | "config" | "bindingConfig">;
  canEdit: boolean;
  /** Arrived from a link that names this section: scroll to it and put the cursor in its URL. */
  focus?: boolean;
}) {
  const update = useUpdateProviderIntegration(projectId);
  const [failure, setFailure] = useState<string | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const decides = labelDecidesFor(binding);

  // After the drawer around it has taken focus for itself, which it does once it opens.
  useEffect(() => {
    if (!focus || !decides) return;
    const timer = window.setTimeout(() => {
      sectionRef.current?.scrollIntoView?.({ block: "start" });
      sectionRef.current
        ?.querySelector<HTMLInputElement>(`input[aria-label="${probeUrlLabel(0)}"]`)
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

  const write = (verify: Record<string, unknown> | null) => {
    setFailure(null);
    update.mutate(
      { id: binding.id, body: { config: { [VERIFY_KEY]: verify } } },
      { onError: (err) => setFailure(formatApiError(err)) },
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
          canRemove={ownDeclared}
          busy={update.isPending}
          onSave={write}
          onRemove={() => write(null)}
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

function Editor({
  seed,
  stableReads,
  dropsTimeout,
  canRemove,
  busy,
  onSave,
  onRemove,
}: {
  seed: ProbeRow[];
  stableReads: unknown;
  dropsTimeout: boolean;
  canRemove: boolean;
  busy: boolean;
  onSave: (verify: Record<string, unknown>) => void;
  onRemove: () => void;
}) {
  const [rows, setRows] = useState<ProbeRow[]>(() => seedRows(seed));
  const [problems, setProblems] = useState<string[]>([]);
  const setRow = (i: number, patch: Partial<ProbeRow>) =>
    setRows((cur) => cur.map((row, j) => (j === i ? { ...row, ...patch } : row)));

  const save = () => {
    const answer = probeWrite(rows, stableReads);
    if (!answer.ok) {
      setProblems(answer.problems);
      return;
    }
    setProblems([]);
    onSave(answer.verify);
  };

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-3">
        {rows.map((row, i) => (
          // A row IS its position; a half-typed url is not.
          // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity
          <li key={i} className="flex flex-col gap-2 sm:flex-row sm:items-start">
            <div className="min-w-0 flex-1">
              <Input
                value={row.url}
                onChange={(e) => setRow(i, { url: e.target.value })}
                placeholder="https://api.example.com/version"
                inputMode="url"
                maxLength={500}
                disabled={busy}
                aria-label={probeUrlLabel(i)}
              />
            </div>
            <div className="flex items-start gap-2 sm:w-48">
              <div className="min-w-0 flex-1">
                <Input
                  value={row.commitPath}
                  onChange={(e) => setRow(i, { commitPath: e.target.value })}
                  placeholder="sourceCommit"
                  maxLength={200}
                  disabled={busy}
                  aria-label={`Probe ${i + 1} commit field`}
                />
              </div>
              {rows.length > 1 && (
                <IconButton
                  icon="trash"
                  aria-label={`Remove probe ${i + 1}`}
                  disabled={busy}
                  onClick={() => setRows((cur) => cur.filter((_, j) => j !== i))}
                />
              )}
            </div>
          </li>
        ))}
      </ul>
      <p className="fg-caption text-subtle">
        The URL answers with the commit the live deployment is serving. The commit field is where that
        commit sits in its JSON answer, as a dot path such as <span className="font-mono">data.commit</span>.
        Left blank, the whole answer is the commit.
      </p>
      {dropsTimeout && (
        <p className="fg-caption text-subtle">
          The stored probe also carries <span className="font-mono">timeoutSeconds</span>, which no release
          reads any more. Saving here leaves it out.
        </p>
      )}
      {problems.length > 0 && (
        <div role="alert" className="fg-body-sm flex flex-col gap-1" style={FIELD_ERROR}>
          {problems.map((p) => (
            <p key={p}>{p}</p>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" disabled={busy} onClick={save}>
          Save probe
        </Button>
        {rows.length < MAX_PROBES && (
          <Button
            variant="ghost"
            size="sm"
            icon="plus"
            disabled={busy}
            onClick={() => setRows((cur) => [...cur, { url: "", commitPath: "" }])}
          >
            Add another probe
          </Button>
        )}
        {canRemove && (
          <Button variant="ghost" size="sm" disabled={busy} onClick={onRemove}>
            Remove probe
          </Button>
        )}
      </div>
    </div>
  );
}
