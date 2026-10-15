// FB-128 — where a connection made from `/integrations` by its provider's own create step lands after
// it (`?bind=<connectionId>`): each project it serves, with the target core lists for it (a GitHub
// App's repositories), bound in one save. Core writes every binding or none, and a refusal names the
// project and target. Each project opens ticked with the repository core suggested for it; one with
// several candidates stays unticked with them named, and one with none stays unticked.

import { useState } from "react";
import { Banner, Button, Checkbox, NativeSelect, SlideOver, Spinner } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { useBindConnectionInto, useConnectionTargets, useConnections } from "../hooks";
import { bindingRefusalText } from "../bind-actions";
import { connectionTargetFor } from "../providers/registry";
import type { BindingTarget, ConnectionBindingItem } from "../types";
import { formatApiError } from "@/lib/api/error";

type SpaceProject = { id: string; slug: string; name: string };

export function BindConnectionDrawer({
  connectionId,
  onClose,
  projects,
}: {
  connectionId: string;
  onClose: () => void;
  projects: SpaceProject[];
}) {
  const t = useCopy();
  const connections = useConnections();
  const targets = useConnectionTargets(connectionId);
  const bind = useBindConnectionInto(connectionId);
  const connection = connections.data?.items.find((c) => c.id === connectionId);
  const repos = targets.data?.targets ?? [];
  const fullName = (r: BindingTarget) => connectionTargetFor(r.provider, r) ?? JSON.stringify(r);
  // only the projects this drawer lists: one of another org is never bound unseen
  const suggestions = (targets.data?.suggestedFor ?? []).filter((s) => projects.some((p) => p.id === s.projectId));
  // project id → the repository's full name, for each project ticked; until the person changes one,
  // what core suggested
  const [chosen, setChosen] = useState<Record<string, string> | null>(null);
  const picked =
    chosen ??
    Object.fromEntries(suggestions.flatMap((s) => (s.by === "ambiguous" ? [] : [[s.projectId, fullName(s.target)] as const])));
  const candidatesOf = (projectId: string) => {
    const s = suggestions.find((x) => x.projectId === projectId);
    return s?.by === "ambiguous" ? s.candidates.map(fullName) : null;
  };

  const items: ConnectionBindingItem[] = Object.entries(picked).flatMap(([projectId, name]) => {
    const target = repos.find((r) => fullName(r) === name);
    return target ? [{ projectId, role: "service" as const, target }] : [];
  });
  const complete = items.length > 0 && items.length === Object.keys(picked).length;

  return (
    <SlideOver
      open
      onClose={onClose}
      title={t("integrations.bindFlow.title", { connection: connection?.displayName ?? t("integrations.github.existingApp") })}
      width={560}
    >
      <div className="flex flex-col gap-4" data-testid="bind-connection-flow">
        {targets.isLoading ? (
          <Spinner />
        ) : targets.isError ? (
          <Banner tone="danger">{formatApiError(targets.error)}</Banner>
        ) : repos.length === 0 ? (
          <Banner tone="attention">{t("integrations.github.noRepos")}</Banner>
        ) : (
          <ul className="flex flex-col divide-y divide-line-subtle">
            {projects.map((p) => {
              const ticked = p.id in picked;
              const candidates = candidatesOf(p.id);
              return (
                <li key={p.id} className="flex flex-wrap items-center gap-3 py-2">
                  <div className="flex min-w-40 flex-1 flex-col gap-0.5">
                    <Checkbox
                      checked={ticked}
                      onChange={() => {
                        const next = { ...picked };
                        if (ticked) delete next[p.id];
                        else next[p.id] = "";
                        setChosen(next);
                      }}
                      label={p.name}
                    />
                    {candidates && !ticked && (
                      <span className="fg-body-sm text-muted">
                        {t("integrations.bindFlow.ambiguous", { repos: candidates.join(", ") })}
                      </span>
                    )}
                  </div>
                  {ticked && (
                    <div className="w-full sm:w-64">
                      <NativeSelect
                        value={picked[p.id] ?? ""}
                        onChange={(e) => setChosen({ ...picked, [p.id]: e.target.value })}
                        aria-label={t("integrations.bindFlow.repoFor", { project: p.name })}
                        options={[
                          { value: "", label: t("integrations.github.chooseRepo") },
                          ...repos.map((r) => ({ value: fullName(r), label: fullName(r) })),
                        ]}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {targets.data?.truncated && <p className="fg-body-sm text-subtle">{t("integrations.github.truncated")}</p>}
        {bind.isError && <Banner tone="danger">{bindingRefusalText(bind.error)}</Banner>}
        <div className="flex items-center gap-3">
          <Button variant="primary" disabled={!complete} loading={bind.isPending} onClick={() => bind.mutate(items, { onSuccess: onClose })}>
            {t("integrations.bindFlow.submit", { n: items.length })}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {t("integrations.bindFlow.later")}
          </Button>
        </div>
      </div>
    </SlideOver>
  );
}
