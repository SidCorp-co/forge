"use client";

import { Banner, Field, Input, Select, type SelectOption } from "@/design";
import { providerCanDeploy } from "@forge/contracts/deploy-capability";
import { useState } from "react";
import { useCopy } from "@/lib/i18n/interface-language";
import type { BindingRole } from "../../types";
import { AddBindingForm, LabelField, labelError, useAddBinding } from "../add-binding";
import { epodsystem } from "./index";


export function AddEpodsystemForm({
  projectId,
  hasDefault,
  onDone,
}: {
  projectId: string;
  hasDefault: boolean;
  onDone: () => void;
}) {
  const add = useAddBinding(projectId, epodsystem.agentPathKind);
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [role, setRole] = useState<BindingRole>("service");
  const canDeploy = providerCanDeploy("epodsystem");
  const t = useCopy();
  const roleOptions: SelectOption[] = [
    { value: "service", label: t("integrations.form.roleService") },
    { value: "deploy", label: t("integrations.form.roleDeploy") },
  ];
  const badLabel = labelError(label, t("integrations.epod.labelKebab"));
  const canSubmit =
    apiKey.trim().length >= 8 && (!hasDefault || (label.trim().length > 0 && !badLabel)) && !add.pending;

  const handleCreate = () =>
    add.submit(
      {
        provider: "epodsystem",
        role: role === "deploy" ? "deploy" : "service",
        config: {},
        secrets: { apiKey: apiKey.trim() },
        ...(label.trim() ? { label: label.trim() } : {}),
      },
      onDone,
    );

  return (
    <AddBindingForm
      add={add}
      title={t("integrations.epod.add")}
      submitLabel={t("integrations.epod.add")}
      canSubmit={canSubmit}
      onSubmit={handleCreate}
      onCancel={onDone}
    >
      {hasDefault && (
        <LabelField
          hint={t("integrations.epod.labelHint")}
          placeholder="partner-a"
          value={label}
          onChange={setLabel}
          error={badLabel}
        />
      )}
      <Field label={t("integrations.edit.apiKey")} hint={t("integrations.epod.keyHint")} required>
        <Input
          type="password"
          autoComplete="new-password"
          placeholder="crmk_…"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </Field>
      <Field
        label={t("integrations.form.role")}
        hint={t("integrations.epod.roleHint")}
        required
      >
        <Select
          options={roleOptions}
          value={role}
          onChange={(v) => {
            setRole(v as BindingRole);
            add.setError(null);
          }}
          disabled={add.pending}
        />
      </Field>
      {role === "deploy" && <DeployRoleNote canDeploy={canDeploy} />}
    </AddBindingForm>
  );
}

/** Where a deploy-role storefront's environment is named, or why it cannot be one. */
function DeployRoleNote({ canDeploy }: { canDeploy: boolean }) {
  const t = useCopy();
  return canDeploy ? (
    <p className="fg-body-sm text-muted">
      {t("integrations.epod.deployWhere.lead")} <code>environments.&lt;name&gt;.deployment.binding</code>{" "}
      {t("integrations.epod.deployWhere.tail")}
    </p>
  ) : (
    <Banner tone="attention">{t("integrations.epod.cannotDeploy")}</Banner>
  );
}
