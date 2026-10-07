"use client";

import { Field, Input, Select, type SelectOption } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { useState } from "react";
import type { BindingRole } from "../../types";
import { AddBindingForm, LabelField, labelError, useAddBinding } from "../add-binding";
import { autoflow } from "./index";
import { EMPTY_TOKENS, RefreshPairFields, SHOP_REGEX, TOKEN_PREFIX, tokenSecrets, tokensValid } from "./tokens";


export function AddAutoflowForm({
  projectId,
  hasDefault,
  onDone,
}: {
  projectId: string;
  hasDefault: boolean;
  onDone: () => void;
}) {
  const add = useAddBinding(projectId, autoflow.agentPathKind);
  const [label, setLabel] = useState("");
  const [shop, setShop] = useState("");
  const [tokens, setTokens] = useState(EMPTY_TOKENS);
  const [role, setRole] = useState<BindingRole>("source");
  const t = useCopy();
  const roleOptions: SelectOption[] = [
    { value: "source", label: t("integrations.autoflow.roleSource") },
    { value: "deploy", label: t("integrations.autoflow.roleDeploy") },
    { value: "service", label: t("integrations.form.roleService") },
  ];

  const shopError = shop && !SHOP_REGEX.test(shop) ? t("integrations.autoflow.shopError") : null;
  const tokenError =
    tokens.token && !tokens.token.trim().startsWith(TOKEN_PREFIX) ? t("integrations.autoflow.tokenError") : null;
  const badLabel = labelError(label, t("integrations.form.labelKebab"));
  const canSubmit =
    SHOP_REGEX.test(shop) && tokensValid(tokens) && (!hasDefault || (label.length > 0 && !badLabel)) && !add.pending;

  const handleCreate = () =>
    add.submit(
      {
        provider: "autoflow",
        role,
        config: { shop },
        secrets: tokenSecrets(tokens),
        ...(label ? { label } : {}),
      },
      onDone,
    );

  return (
    <AddBindingForm
      add={add}
      title={t("integrations.autoflow.add")}
      submitLabel={t("integrations.autoflow.add")}
      canSubmit={canSubmit}
      onSubmit={handleCreate}
      onCancel={onDone}
    >
      {hasDefault && (
        <LabelField
          hint={t("integrations.form.labelHint")}
          placeholder="staging"
          value={label}
          onChange={setLabel}
          error={badLabel}
        />
      )}
      <Field label={t("integrations.autoflow.shop")} hint={t("integrations.autoflow.shopHint")} required>
        <Input placeholder="hop" value={shop} onChange={(e) => setShop(e.target.value.toLowerCase())} />
        {shopError && <p className="fg-body-sm text-danger">{shopError}</p>}
      </Field>
      <Field
        label={t("integrations.autoflow.token")}
        hint={t("integrations.autoflow.tokenHint")}
        required
      >
        <Input
          type="password"
          autoComplete="new-password"
          placeholder="sat_…"
          value={tokens.token}
          onChange={(e) => setTokens({ ...tokens, token: e.target.value })}
        />
        {tokenError && <p className="fg-body-sm text-danger">{tokenError}</p>}
      </Field>
      <RefreshPairFields value={tokens} onChange={setTokens} />
      <Field label={t("integrations.form.role")} required>
        <Select options={roleOptions} value={role} onChange={(v) => setRole(v as BindingRole)} />
      </Field>
    </AddBindingForm>
  );
}
