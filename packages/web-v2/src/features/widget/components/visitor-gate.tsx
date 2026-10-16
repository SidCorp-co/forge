import type { WidgetPublicConfig } from "@forge/contracts/widget";
import { Button, Field, Input, Spinner } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { type FormEvent, useState } from "react";
import type { Shown } from "../refusal";
import { RefusalNote } from "./refusal-note";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function Greeting({ greeting }: { greeting: string | null }) {
  return greeting ? <p className="fg-body whitespace-pre-line text-fg">{greeting}</p> : null;
}

/**
 * Who the visitor is, asked the way the binding wants: an email they may give (`anonymous`) or must
 * give (`email`). A returning visitor finds the email they gave last time already in the field.
 */
export function AskVisitor({
  config,
  keptEmail,
  refusal,
  onStart,
}: {
  config: WidgetPublicConfig;
  keptEmail: string | null;
  refusal: Shown | null;
  onStart: (visitor: { email?: string }) => void;
}) {
  const t = useCopy();
  const required = config.identity.mode === "email";
  const [email, setEmail] = useState(keptEmail ?? "");
  const [touched, setTouched] = useState(false);
  const typed = email.trim();
  const invalid = (required || typed !== "") && !EMAIL.test(typed);

  function submit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (invalid) return;
    onStart(typed ? { email: typed } : {});
  }

  return (
    <form className="flex flex-1 flex-col justify-end gap-4 p-4" onSubmit={submit} noValidate data-testid="widget-gate">
      <Greeting greeting={config.greeting} />
      {refusal && <RefusalNote refusal={refusal} />}
      <Field
        label={required ? t("widget.gate.email") : t("widget.gate.emailOptional")}
        required={required}
        hint={t("widget.gate.emailUse")}
        error={touched && invalid ? t("widget.gate.emailInvalid") : undefined}
      >
        <Input
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder={t("widget.gate.emailPlaceholder")}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          data-autofocus=""
        />
      </Field>
      <Button type="submit" variant="primary">
        {t("widget.gate.start")}
      </Button>
    </form>
  );
}

/** Signed mode: the page signs its own user in, so the frame waits for it and asks nothing. */
export function WaitForSignIn({ config, refusal }: { config: WidgetPublicConfig; refusal: Shown | null }) {
  const t = useCopy();
  return (
    <div className="flex flex-1 flex-col justify-end gap-4 p-4" data-testid="widget-wait">
      <Greeting greeting={config.greeting} />
      {refusal ? (
        <RefusalNote refusal={refusal} />
      ) : (
        <p className="fg-body-sm flex items-center gap-2 text-muted" role="status">
          <Spinner size={14} />
          {t("widget.gate.waiting")}
        </p>
      )}
    </div>
  );
}
