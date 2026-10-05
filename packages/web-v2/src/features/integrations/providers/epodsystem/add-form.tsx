"use client";

import { Banner, Field, Input, Select, type SelectOption } from "@/design";
import { providerCanDeploy } from "@forge/contracts/deploy-capability";
import { useState } from "react";
import type { BindingRole } from "../../types";
import { AddBindingForm, LabelField, labelError, useAddBinding } from "../add-binding";
import { epodsystem } from "./index";

const ROLE_SELECT_OPTIONS: SelectOption[] = [
  { value: "service", label: "Service — a project-wide facility" },
  { value: "deploy", label: "Deploy target — somewhere Forge deploys to" },
];

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
  const badLabel = labelError(
    label,
    "Label must be kebab-case (lowercase letters, numbers, dashes; e.g. partner-a)",
  );
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
      title="Add storefront"
      submitLabel="Add storefront"
      canSubmit={canSubmit}
      onSubmit={handleCreate}
      onCancel={onDone}
    >
      {hasDefault && (
        <LabelField
          hint="Unique kebab-case name for this storefront (e.g. partner-a). Required for extra connections."
          placeholder="partner-a"
          value={label}
          onChange={setLabel}
          error={badLabel}
        />
      )}
      <Field label="API key" hint="Epodsystem API key (crmk_…). Stored encrypted; never shown again." required>
        <Input
          type="password"
          autoComplete="new-password"
          placeholder="crmk_…"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </Field>
      <Field
        label="What is it for"
        hint="A storefront this project publishes to is a deploy target. One it only borrows (an MCP, a product feed) is a service."
        required
      >
        <Select
          options={ROLE_SELECT_OPTIONS}
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
  return canDeploy ? (
    <p className="fg-body-sm text-muted">
      Which environment this storefront deploys is the project document&apos;s: name the binding in{" "}
      <code>environments.&lt;name&gt;.deployment.binding</code> of the project document, on the
      Configuration tab of project settings.
    </p>
  ) : (
    <Banner tone="attention">
      Forge cannot deploy to Epodsystem — it has no deploy adapter. Add it as a service instead.
    </Banner>
  );
}
