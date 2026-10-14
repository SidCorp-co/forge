// FB-128 — where a connection made from `/integrations` by its provider's own create step lands after
// it (`?bind=<connectionId>`): each project it serves, with the target core lists for it (a GitHub
// App's repositories), bound in one save. Core writes every binding or none, and a refusal names the
// project and target.

import { useState } from "react";
import { Banner, Button, Checkbox, NativeSelect, SlideOver, Spinner } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { useBindConnectionInto, useConnectionTargets, useConnections } from "../hooks";
import { bindingRefusalText } from "../bind-actions";
import { connectionTargetFor } from "../providers/registry";
import type { ConnectionBindingItem } from "../types";
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
  // project id → the repository's full name, for each project ticked
  const [picked, setPicked] = useState<Record<string, string>>({});
  const connection = connections.data?.items.find((c) => c.id === connectionId);
  const repos = targets.data?.targets ?? [];
  const fullName = (r: (typeof repos)[number]) => connectionTargetFor(r.provider, r) ?? JSON.stringify(r);

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
              return (
                <li key={p.id} className="flex flex-wrap items-center gap-3 py-2">
                  <div className="min-w-40 flex-1">
                    <Checkbox
                      checked={ticked}
                      onChange={() =>
                        setPicked((prev) => {
                          const next = { ...prev };
                          if (ticked) delete next[p.id];
                          else next[p.id] = "";
                          return next;
                        })
                      }
                      label={p.name}
                    />
                  </div>
                  {ticked && (
                    <div className="w-full sm:w-64">
                      <NativeSelect
                        value={picked[p.id] ?? ""}
                        onChange={(e) => setPicked((prev) => ({ ...prev, [p.id]: e.target.value }))}
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
