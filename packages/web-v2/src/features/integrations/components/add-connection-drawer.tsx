// FB-128 — adding a connection is finished on `/integrations`: choose the app, pick the projects it
// serves, fill the app's own connect form, and one save binds every chosen project. The form is the
// provider's project section, rendered for the first chosen project with the rest handed to it
// through `AlsoBindProvider`, so there is one connect form per provider, not a second copy here.
// A provider that mints its credential itself names its own `createStep` in the registry: one step
// for the active org, no project ticked, whose return lands back here, where
// `BindConnectionDrawer` binds it.

import { createElement, lazy, Suspense, useState } from "react";
import { Checkbox, Field, NativeSelect, Skeleton, SlideOver } from "@/design";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import { AlsoBindProvider } from "../also-bind";
import { PROVIDER_MODULES, providerLabel } from "../providers/registry";
import { ProviderDetails } from "./connection-detail-drawer";

type SpaceProject = { id: string; slug: string; name: string };

const CONNECTABLE = PROVIDER_MODULES.filter((m) => m.section !== null || m.createStep !== null).map((m) => m.provider);

// Each provider's own create step, made lazy once here at module scope.
const CREATE_STEPS = new Map(
  PROVIDER_MODULES.flatMap((m) => (m.createStep ? [[m.provider, lazy(m.createStep)] as const] : [])),
);

export function AddConnectionDrawer({
  open,
  onClose,
  projects,
  orgId,
}: {
  open: boolean;
  onClose: () => void;
  projects: SpaceProject[];
  /** The active org a provider-minted connection is made for. */
  orgId: string | null;
}) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const [chosen, setChosen] = useState<string[]>([]);
  const [provider, setProvider] = useState("");
  const ordered = projects.filter((p) => chosen.includes(p.id));
  const [first, ...rest] = ordered;
  const CREATE_STEP = CREATE_STEPS.get(provider);
  const toggle = (id: string) =>
    setChosen((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  return (
    <SlideOver open={open} onClose={onClose} title={t("integrations.addFlow.title")} width={560}>
      <div className="flex flex-col gap-5" data-testid="add-connection-flow">
        <Field label={t("integrations.addFlow.app")}>
          <NativeSelect
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            aria-label={t("integrations.addFlow.app")}
            options={[
              { value: "", label: t("integrations.addFlow.chooseApp") },
              ...CONNECTABLE.map((p) => ({ value: p, label: providerLabel(p, language) })),
            ]}
          />
        </Field>

        {CREATE_STEP ? (
          orgId ? (
            <Suspense fallback={<Skeleton className="h-40 w-full" />}>{createElement(CREATE_STEP, { orgId })}</Suspense>
          ) : (
            <p className="fg-body-sm text-subtle">{t("integrations.addFlow.orgFirst")}</p>
          )
        ) : (
          <>
            <Field label={t("integrations.addFlow.projects")}>
              {projects.length === 0 ? (
                <p className="fg-body-sm text-subtle">{t("integrations.addNoProject")}</p>
              ) : (
                <div className="flex flex-col gap-1">
                  {projects.map((p) => (
                    <Checkbox key={p.id} checked={chosen.includes(p.id)} onChange={() => toggle(p.id)} label={p.name} />
                  ))}
                </div>
              )}
            </Field>

            {!first || !provider ? (
              <p className="fg-body-sm text-muted">{t("integrations.addFlow.pickFirst")}</p>
            ) : (
              <div className="flex flex-col gap-3">
                {rest.length > 0 && (
                  <p className="fg-body-sm text-muted">
                    {t("integrations.addFlow.bindsAll", { projects: ordered.map((p) => p.name).join(", ") })}
                  </p>
                )}
                <AlsoBindProvider value={rest.map((p) => p.id)}>
                  <ProviderDetails key={`${provider}:${first.id}`} provider={provider} projectId={first.id} />
                </AlsoBindProvider>
              </div>
            )}
          </>
        )}
      </div>
    </SlideOver>
  );
}
