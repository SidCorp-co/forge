// FB-128 — adding a connection is finished on `/integrations`: pick the projects it serves and the
// app, fill the app's own connect form, and one save binds every chosen project. The form is the
// provider's project section, rendered for the first chosen project with the rest handed to it
// through `AlsoBindProvider`, so there is one connect form per provider, not a second copy here.
// GitHub mints its credential itself: the App is named after the first project, and the install
// step lands back here, where `BindConnectionDrawer` binds it.

import { useState } from "react";
import { Checkbox, Field, NativeSelect, SlideOver } from "@/design";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import { AlsoBindProvider } from "../also-bind";
import { CreateApp } from "../providers/github/create-app";
import { PROVIDER_MODULES, providerLabel } from "../providers/registry";
import { ProviderDetails } from "./connection-detail-drawer";

type SpaceProject = { id: string; slug: string; name: string };

const CONNECTABLE = PROVIDER_MODULES.filter((m) => m.section !== null).map((m) => m.provider);

export function AddConnectionDrawer({
  open,
  onClose,
  projects,
}: {
  open: boolean;
  onClose: () => void;
  projects: SpaceProject[];
}) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const [chosen, setChosen] = useState<string[]>([]);
  const [provider, setProvider] = useState("");
  const ordered = projects.filter((p) => chosen.includes(p.id));
  const [first, ...rest] = ordered;
  const toggle = (id: string) =>
    setChosen((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  return (
    <SlideOver open={open} onClose={onClose} title={t("integrations.addFlow.title")} width={560}>
      <div className="flex flex-col gap-5" data-testid="add-connection-flow">
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

        {!first || !provider ? (
          <p className="fg-body-sm text-muted">{t("integrations.addFlow.pickFirst")}</p>
        ) : provider === "github" ? (
          <div className="flex flex-col gap-3">
            <p className="fg-body-sm text-muted">{t("integrations.addFlow.githubNamed", { project: first.name })}</p>
            <CreateApp projectId={first.id} onBack={null} returnTo="integrations" />
          </div>
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
      </div>
    </SlideOver>
  );
}
