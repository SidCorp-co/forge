"use client";

import { Badge, Button, Input, NativeSelect } from "@/design";
import { useMemo } from "react";
import { useCopy } from "@/lib/i18n/interface-language";
import { useCoolifyApplications, useCoolifyTargets } from "../../hooks";
import type { CoolifyApplication, CoolifyTargetInput } from "../../types";

type Identity = NonNullable<ReturnType<typeof useCoolifyTargets>["data"]>["targets"][number];

const ALIGN_LABEL_COL = "hidden w-40 shrink-0 sm:block";
const ALIGN_BUTTON_COL = "hidden w-9 shrink-0 sm:block";

export function CoolifyTargetsField({
  projectId,
  integrationId,
  baseUrl,
  apiToken,
  targets,
  onChange,
  inherited,
}: {
  projectId: string;
  integrationId: string | undefined;
  baseUrl: string;
  apiToken: string;
  targets: CoolifyTargetInput[];
  onChange: (next: CoolifyTargetInput[]) => void;
  inherited: boolean;
}) {
  const auth = integrationId
    ? { integrationId }
    : baseUrl.trim() && apiToken.trim().length >= 8
      ? { baseUrl: baseUrl.trim(), apiToken: apiToken.trim() }
      : null;
  const apps = useCoolifyApplications(projectId, auth);
  const identities = useCoolifyTargets(projectId, integrationId);

  const options = useMemo(
    () =>
      (apps.data?.applications ?? []).map((a: CoolifyApplication) => ({
        value: a.uuid,
        label: a.name ? `${a.name} — ${a.uuid.slice(0, 8)}` : a.uuid,
      })),
    [apps.data],
  );
  const identityFor = (uuid: string) => (identities.data?.targets ?? []).find((row) => row.uuid === uuid);
  const t = useCopy();

  function updateTarget(idx: number, patch: Partial<CoolifyTargetInput>) {
    onChange(targets.map((row, i) => (i === idx ? { ...row, ...patch } : row)));
  }

  return (
    <fieldset className="flex flex-col gap-3 border-t border-line-subtle pt-3">
      <legend className="fg-label px-1 text-subtle">{t("integrations.coolify.targets")}</legend>
      <p className="fg-body-sm text-muted">
        {t("integrations.coolify.targetsIntro")}
        {inherited ? ` ${t("integrations.coolify.targetsInherited")}` : ""}
      </p>
      {apps.isError && <p className="fg-body-sm text-muted">{t("integrations.coolify.appsUnread")}</p>}
      {targets.map((row, idx) => (
        <TargetRow
          key={row.id ?? idx}
          target={row}
          first={idx === 0}
          options={options}
          identity={identityFor(row.resourceUuid)}
          onPatch={(patch) => updateTarget(idx, patch)}
          onRemove={targets.length <= 1 ? undefined : () => onChange(targets.filter((_, i) => i !== idx))}
        />
      ))}
      <div>
        <Button
          variant="secondary"
          size="sm"
          icon="plus"
          onClick={() => onChange([...targets, { label: "", resourceUuid: "" }])}
        >
          {t("integrations.coolify.addTarget")}
        </Button>
      </div>
    </fieldset>
  );
}

/** A column caption, shown above the first row only. */
function Caption({ show, children }: { show: boolean; children: string }) {
  return show ? <span className="fg-label mb-1 block text-subtle">{children}</span> : null;
}

function TargetRow({
  target: t,
  first,
  options,
  identity,
  onPatch,
  onRemove,
}: {
  target: CoolifyTargetInput;
  first: boolean;
  options: { value: string; label: string }[];
  identity: Identity | undefined;
  onPatch: (patch: Partial<CoolifyTargetInput>) => void;
  onRemove: (() => void) | undefined;
}) {
  const c = useCopy();
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-end gap-2 sm:flex-nowrap">
        <div className="w-full shrink-0 sm:w-40">
          <Caption show={first}>{c("integrations.provider.label")}</Caption>
          <Input value={t.label} onChange={(e) => onPatch({ label: e.target.value })} placeholder="Backend" />
        </div>
        <div className="min-w-0 flex-1">
          <Caption show={first}>{c("integrations.coolify.app")}</Caption>
          {options.length > 0 ? (
            <NativeSelect
              aria-label={c("integrations.coolify.app")}
              value={t.resourceUuid}
              options={[{ value: "", label: c("integrations.coolify.selectApp") }, ...options]}
              onChange={(e) => onPatch({ resourceUuid: e.target.value })}
            />
          ) : (
            <Input
              value={t.resourceUuid}
              onChange={(e) => onPatch({ resourceUuid: e.target.value })}
              placeholder={c("integrations.coolify.uuidPlaceholder")}
            />
          )}
        </div>
        <Button variant="ghost" icon="trash" aria-label={c("integrations.coolify.removeTarget")} disabled={!onRemove} onClick={onRemove} />
      </div>
      <div className="flex items-end gap-2">
        <div className={ALIGN_LABEL_COL} aria-hidden />
        <div className="min-w-0 flex-1">
          <Caption show={first}>{c("integrations.coolify.health")}</Caption>
          <Input
            aria-label={c("integrations.coolify.healthFor", { target: t.label || c("integrations.coolify.thisTarget") })}
            value={t.healthUrl ?? ""}
            onChange={(e) => onPatch({ healthUrl: e.target.value })}
            placeholder="https://api.example.com/health"
          />
        </div>
        <div className={ALIGN_BUTTON_COL} aria-hidden />
      </div>
      {identity && !identity.found && <Badge tone="red">{c("integrations.coolify.notListed")}</Badge>}
      {identity?.found && (
        <span className="fg-body-sm text-muted">
          {identity.name ?? c("integrations.coolify.unnamed")}
          {identity.fqdn ? ` · ${identity.fqdn}` : ""}
          {identity.gitBranch ? ` · ${identity.gitBranch}` : ""}
          {identity.gitCommitSha ? `@${identity.gitCommitSha.slice(0, 7)}` : ""}
        </span>
      )}
    </div>
  );
}
