import { Banner, Button } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { useState } from "react";
import { bindingRefusalText } from "../../bind-actions";
import { IntegrationEnabledControl } from "../../components/integration-enabled-control";
import { useDeleteProviderIntegration, useUpdateProviderIntegration } from "../../hooks";
import type { IntegrationSummary } from "../../types";
import { AddBindingForm, LabelField, labelError, useAddBinding } from "../add-binding";
import { BindingRowHeader, MultiBindingSettings } from "../multi-binding";
import { activeBadge } from "../shared";
import { EMPTY_FORM, type FieldErrors, formOf, mintSiteKey, parseForm, patchOf, type WidgetForm } from "./config";
import { EmbedCode, SigningSecret } from "./embed";
import { WidgetFields } from "./fields";
import { widget } from "./index";

/** The feedback widgets this project's client sites embed, one per label. */
export function WidgetSettings({ projectId }: { projectId: string }) {
  const t = useCopy();
  return (
    <MultiBindingSettings
      projectId={projectId}
      provider={widget.provider}
      title={t("integrations.widget.title")}
      emptyText={t("integrations.widget.none")}
      addLabel={t("integrations.widget.add")}
      renderRow={(binding, isDefault) => (
        <WidgetBinding key={binding.id} projectId={projectId} binding={binding} isDefault={isDefault} />
      )}
      renderAdd={(hasDefault, onDone) => <AddWidgetForm projectId={projectId} hasDefault={hasDefault} onDone={onDone} />}
    />
  );
}

export function AddWidgetForm({ projectId, hasDefault, onDone }: { projectId: string; hasDefault: boolean; onDone: () => void }) {
  const t = useCopy();
  const add = useAddBinding(projectId, widget.agentPathKind);
  const [siteKey] = useState(mintSiteKey);
  const [label, setLabel] = useState("");
  const [form, setForm] = useState<WidgetForm>(EMPTY_FORM);
  const [errors, setErrors] = useState<FieldErrors>({});
  const badLabel = labelError(label, t("integrations.form.labelKebab"));

  function submit() {
    const parsed = parseForm(form, siteKey);
    setErrors(parsed.errors ?? {});
    if (!parsed.config) return;
    void add.submit(
      { provider: widget.provider, role: "service", config: parsed.config, secrets: {}, ...(label ? { label } : {}) },
      onDone,
    );
  }

  return (
    <AddBindingForm
      add={add}
      title={t("integrations.widget.add")}
      submitLabel={t("integrations.widget.create")}
      canSubmit={!add.pending && (!hasDefault || (label.length > 0 && !badLabel))}
      onSubmit={submit}
      onCancel={onDone}
    >
      {hasDefault && <LabelField placeholder={t("integrations.widget.labelPlaceholder")} value={label} onChange={setLabel} error={badLabel} />}
      <WidgetFields form={form} errors={errors} set={setForm} />
    </AddBindingForm>
  );
}

function WidgetBinding({ projectId, binding, isDefault }: { projectId: string; binding: IntegrationSummary; isDefault: boolean }) {
  const t = useCopy();
  const update = useUpdateProviderIntegration(projectId);
  const remove = useDeleteProviderIntegration(projectId);
  const saved = formOf(binding.config ?? {});
  const siteKey = typeof binding.config?.siteKey === "string" ? binding.config.siteKey : null;
  const [form, setForm] = useState<WidgetForm>(saved);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const badge = activeBadge(binding, t) ?? { label: t("integrations.status.connected"), tone: "green" as const };

  async function save() {
    if (!siteKey) return;
    const parsed = parseForm(form, siteKey);
    setErrors(parsed.errors ?? {});
    setError(null);
    if (!parsed.config) return;
    try {
      await update.mutateAsync({ id: binding.id, body: { config: patchOf(parsed.config) } });
    } catch (err) {
      setError(bindingRefusalText(err));
    }
  }

  return (
    <div className="flex flex-col gap-4" data-testid="widget-binding">
      <BindingRowHeader binding={binding} isDefault={isDefault} badge={badge} monoDefault />
      {siteKey ? <EmbedCode siteKey={siteKey} /> : <Banner tone="danger">{t("integrations.widget.siteKeyMissing")}</Banner>}
      <WidgetFields form={form} errors={errors} set={setForm} />
      {form.mode === "signed" && <SigningSecret projectId={projectId} bindingId={binding.id} />}
      {error && <Banner tone="danger">{error}</Banner>}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={() => void save()} loading={update.isPending} disabled={!siteKey}>
          {t("integrations.widget.save")}
        </Button>
        <IntegrationEnabledControl projectId={projectId} binding={binding} />
        <Button
          variant="danger"
          icon="trash"
          loading={remove.isPending}
          onClick={() => window.confirm(t("integrations.widget.confirmRemove")) && remove.mutate(binding)}
        >
          {t("integrations.widget.remove")}
        </Button>
      </div>
    </div>
  );
}
