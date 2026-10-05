"use client";

import { Field, Input, Select, type SelectOption } from "@/design";
import { useState } from "react";
import type { BindingRole } from "../../types";
import { AddBindingForm, LabelField, labelError, useAddBinding } from "../add-binding";
import { autoflow } from "./index";
import { EMPTY_TOKENS, RefreshPairFields, SHOP_REGEX, TOKEN_PREFIX, tokenSecrets, tokensValid } from "./tokens";

const ROLE_SELECT_OPTIONS: SelectOption[] = [
  { value: "source", label: "Source — the site this project builds" },
  { value: "deploy", label: "Deploy target — where a release publishes" },
  { value: "service", label: "Service — a project-wide facility" },
];

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

  const shopError = shop && !SHOP_REGEX.test(shop) ? "The site slug: lowercase letters, digits and dashes." : null;
  const tokenError =
    tokens.token && !tokens.token.trim().startsWith(TOKEN_PREFIX)
      ? "The shop MCP admits only the OAuth access token (sat_…); a wmk_ API key or srt_ refresh token is refused there."
      : null;
  const badLabel = labelError(label, "Label must be kebab-case (e.g. staging).");
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
      title="Add site"
      submitLabel="Add site"
      canSubmit={canSubmit}
      onSubmit={handleCreate}
      onCancel={onDone}
    >
      {hasDefault && (
        <LabelField
          hint="Unique kebab-case name for this binding."
          placeholder="staging"
          value={label}
          onChange={setLabel}
          error={badLabel}
        />
      )}
      <Field label="Site (shop)" hint="The <shop> of <shop>.auto.sidcorp.co." required>
        <Input placeholder="hop" value={shop} onChange={(e) => setShop(e.target.value.toLowerCase())} />
        {shopError && <p className="fg-body-sm text-danger">{shopError}</p>}
      </Field>
      <Field
        label="Access token"
        hint="Minted by signing in to Sidcorp Auto through an MCP client and picking this workspace and site. Stored encrypted."
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
      <Field label="What is it for" required>
        <Select options={ROLE_SELECT_OPTIONS} value={role} onChange={(v) => setRole(v as BindingRole)} />
      </Field>
    </AddBindingForm>
  );
}
