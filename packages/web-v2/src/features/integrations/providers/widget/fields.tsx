import { WIDGET_IDENTITY_MODES, WIDGET_LIMIT_DEFAULTS, type WidgetIdentityMode } from "@forge/contracts/widget";
import { Button, Disclosure, Field, IconButton, Input, Radio, RadioGroup, Textarea } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";
import { type FieldErrors, LIMIT_KEYS, type LimitKey, limitBounds, type WidgetForm } from "./config";

const ACCENT = /^#[0-9a-fA-F]{6}$/;
const modeKey = (mode: WidgetIdentityMode): ProductCopyKey => `integrations.widget.mode.${mode}`;
const limitKey = (key: LimitKey): ProductCopyKey => `integrations.widget.limit.${key}`;

function OriginsField({
  origins,
  errors,
  onChange,
}: {
  origins: string[];
  errors: FieldErrors;
  onChange: (origins: string[]) => void;
}) {
  const t = useCopy();
  const wrong = errors.originAt ?? [];
  const error = errors.origins
    ? t("integrations.widget.originsNeeded")
    : wrong.length > 0
      ? t("integrations.widget.originInvalid", { origin: origins.filter((o) => o.trim())[wrong[0] ?? 0] ?? "" })
      : undefined;
  return (
    <Field label={t("integrations.widget.origins")} required error={error}>
      <div className="flex flex-col gap-2" data-testid="widget-origins">
        {origins.map((origin, i) => (
          // the rows are positions in an edited list, so a row's index is what names it
          // eslint-disable-next-line @eslint-react/no-array-index-key
          <div key={i} className="flex items-center gap-2">
            <Input
              aria-label={t("integrations.widget.originN", { n: i + 1 })}
              placeholder={t("integrations.widget.originPlaceholder")}
              value={origin}
              onChange={(e) => onChange(origins.map((o, j) => (j === i ? e.target.value : o)))}
              className="font-mono"
            />
            {origins.length > 1 && (
              <IconButton
                icon="trash"
                size="sm"
                aria-label={t("integrations.widget.removeOrigin", { n: i + 1 })}
                onClick={() => onChange(origins.filter((_, j) => j !== i))}
              />
            )}
          </div>
        ))}
        {origins.length < 20 && (
          <Button className="self-start" size="sm" variant="secondary" icon="plus" onClick={() => onChange([...origins, ""])}>
            {t("integrations.widget.addOrigin")}
          </Button>
        )}
      </div>
    </Field>
  );
}

function LimitsField({ form, errors, set }: { form: WidgetForm; errors: FieldErrors; set: (f: WidgetForm) => void }) {
  const t = useCopy();
  return (
    <Disclosure title={t("integrations.widget.limits")}>
      <div className="grid gap-3 sm:grid-cols-2">
        {LIMIT_KEYS.map((key) => {
          const { min, max } = limitBounds(key);
          return (
            <Field
              key={key}
              label={t(limitKey(key))}
              error={errors[key] ? t("integrations.widget.limitInvalid", { min, max }) : undefined}
            >
              <Input
                type="number"
                inputMode="numeric"
                min={min}
                max={max}
                placeholder={String(WIDGET_LIMIT_DEFAULTS[key])}
                value={form.limits[key]}
                onChange={(e) => set({ ...form, limits: { ...form.limits, [key]: e.target.value } })}
              />
            </Field>
          );
        })}
      </div>
    </Disclosure>
  );
}

/** Every field of the widget binding but its site key, which is minted once and never edited. */
export function WidgetFields({ form, errors, set }: { form: WidgetForm; errors: FieldErrors; set: (f: WidgetForm) => void }) {
  const t = useCopy();
  return (
    <div className="flex flex-col gap-4">
      <OriginsField origins={form.origins} errors={errors} onChange={(origins) => set({ ...form, origins })} />
      <fieldset className="flex flex-col gap-2">
        <legend className="fg-label mb-1.5">{t("integrations.widget.identity")}</legend>
        <RadioGroup
          name="widget-identity"
          value={form.mode}
          onChange={(next) => set({ ...form, mode: WIDGET_IDENTITY_MODES.find((m) => m === next) ?? form.mode })}
        >
          {WIDGET_IDENTITY_MODES.map((mode) => (
            <Radio key={mode} value={mode} label={t(modeKey(mode))} />
          ))}
        </RadioGroup>
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("integrations.widget.chatTitle")} error={errors.title ? t("integrations.widget.titleInvalid") : undefined}>
          <Input
            maxLength={60}
            placeholder={t("integrations.widget.chatTitlePlaceholder")}
            value={form.title}
            onChange={(e) => set({ ...form, title: e.target.value })}
          />
        </Field>
        <Field label={t("integrations.widget.accent")} error={errors.accent ? t("integrations.widget.accentInvalid") : undefined}>
          <div className="flex items-center gap-2">
            <span
              className="size-9 flex-none rounded-md border border-line-strong bg-primary"
              style={ACCENT.test(form.accent) ? { background: form.accent } : undefined}
              aria-hidden
              data-testid="widget-accent-swatch"
            />
            <Input placeholder="#rrggbb" value={form.accent} onChange={(e) => set({ ...form, accent: e.target.value })} className="font-mono" />
          </div>
        </Field>
      </div>
      <Field label={t("integrations.widget.greeting")} error={errors.greeting ? t("integrations.widget.greetingInvalid") : undefined}>
        <Textarea
          rows={2}
          maxLength={400}
          placeholder={t("integrations.widget.greetingPlaceholder")}
          value={form.greeting}
          onChange={(e) => set({ ...form, greeting: e.target.value })}
        />
      </Field>
      <LimitsField form={form} errors={errors} set={set} />
    </div>
  );
}
