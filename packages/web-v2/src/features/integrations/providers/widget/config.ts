import {
  WIDGET_LANGUAGES,
  WIDGET_LIMIT_DEFAULTS,
  WIDGET_SITE_KEY_PREFIX,
  type WidgetBindingConfig,
  type WidgetIdentityMode,
  type WidgetLanguage,
  widgetBindingConfigSchema,
  widgetLimitsSchema,
} from "@forge/contracts/widget";

// The widget binding's form, read from and written to the contract's `widgetBindingConfigSchema`:
// every save is parsed by that schema first, and what it refuses is shown on the field it names.

/** The languages a site writes a greeting of its own in; English reads the one greeting. */
export const GREETING_LANGUAGES = WIDGET_LANGUAGES.filter((l): l is Exclude<WidgetLanguage, "en"> => l !== "en");
export type GreetingLanguage = (typeof GREETING_LANGUAGES)[number];

export const LIMIT_KEYS = Object.keys(WIDGET_LIMIT_DEFAULTS) as (keyof typeof WIDGET_LIMIT_DEFAULTS)[];
export type LimitKey = (typeof LIMIT_KEYS)[number];

export interface WidgetForm {
  origins: string[];
  mode: WidgetIdentityMode;
  title: string;
  greeting: string;
  /** The greeting in each other language the widget writes; blank greets with `greeting`. */
  greetings: Record<GreetingLanguage, string>;
  accent: string;
  /** As typed; blank keeps the default. */
  limits: Record<LimitKey, string>;
}

const NO_LIMITS = Object.fromEntries(LIMIT_KEYS.map((k) => [k, ""])) as Record<LimitKey, string>;

const NO_GREETINGS = Object.fromEntries(GREETING_LANGUAGES.map((l) => [l, ""])) as Record<GreetingLanguage, string>;

export const EMPTY_FORM: WidgetForm = { origins: [""], mode: "anonymous", title: "", greeting: "", greetings: NO_GREETINGS, accent: "", limits: NO_LIMITS };

/** The bounds the contract puts on a limit, read off its schema so the two cannot drift. */
export function limitBounds(key: LimitKey): { min: number; max: number } {
  const schema = widgetLimitsSchema.shape[key].unwrap();
  return { min: schema.minValue ?? 1, max: schema.maxValue ?? Number.MAX_SAFE_INTEGER };
}

/** A new public site key: the prefix and 32 base64url characters from the browser's CSPRNG. */
export function mintSiteKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const b64 = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_");
  return `${WIDGET_SITE_KEY_PREFIX}${b64}`;
}

/** The binding's saved config as the form edits it; what is missing reads blank. */
export function formOf(config: Record<string, unknown>): WidgetForm {
  const read = widgetBindingConfigSchema.partial().safeParse(config);
  const c = read.success ? read.data : {};
  return {
    origins: c.allowedOrigins?.length ? [...c.allowedOrigins] : [""],
    mode: c.identity?.mode ?? "anonymous",
    title: c.title ?? "",
    greeting: c.greeting ?? "",
    greetings: Object.fromEntries(GREETING_LANGUAGES.map((l) => [l, c.greetings?.[l] ?? ""])) as Record<GreetingLanguage, string>,
    accent: c.accent ?? "",
    limits: Object.fromEntries(LIMIT_KEYS.map((k) => [k, c.limits?.[k] === undefined ? "" : String(c.limits[k])])) as Record<
      LimitKey,
      string
    >,
  };
}

export type FieldErrors = Partial<Record<"origins" | "title" | "greeting" | "accent" | LimitKey, string>> & {
  /** Each language whose greeting the schema refused. */
  greetingIn?: GreetingLanguage[];
  /** The index of each origin the schema refused. */
  originAt?: number[];
};

export type Parsed = { config: WidgetBindingConfig; errors: null } | { config: null; errors: FieldErrors };

const blank = (s: string) => s.trim() === "";

/** The form as the contract's config, parsed by its schema; or, field by field, what it refused. */
export function parseForm(form: WidgetForm, siteKey: string): Parsed {
  const limits = Object.fromEntries(
    LIMIT_KEYS.filter((k) => !blank(form.limits[k])).map((k) => [k, Number(form.limits[k].trim())]),
  );
  const greetings = Object.fromEntries(
    GREETING_LANGUAGES.filter((l) => !blank(form.greetings[l])).map((l) => [l, form.greetings[l].trim()]),
  );
  const candidate = {
    siteKey,
    allowedOrigins: form.origins.map((o) => o.trim()).filter((o) => o !== ""),
    identity: { mode: form.mode },
    ...(blank(form.title) ? {} : { title: form.title.trim() }),
    ...(blank(form.greeting) ? {} : { greeting: form.greeting.trim() }),
    ...(Object.keys(greetings).length > 0 ? { greetings } : {}),
    ...(blank(form.accent) ? {} : { accent: form.accent.trim() }),
    ...(Object.keys(limits).length > 0 ? { limits } : {}),
  };
  const read = widgetBindingConfigSchema.safeParse(candidate);
  if (read.success) return { config: read.data, errors: null };
  const errors: FieldErrors = {};
  for (const issue of read.error.issues) {
    const [head, at] = issue.path;
    if (head === "allowedOrigins") {
      if (typeof at === "number") errors.originAt = [...(errors.originAt ?? []), at];
      else errors.origins = issue.message;
    } else if (head === "limits" && typeof at === "string") errors[at as LimitKey] = issue.message;
    else if (head === "greetings") errors.greetingIn = [...(errors.greetingIn ?? []), ...GREETING_LANGUAGES.filter((l) => l === at)];
    else if (head === "title" || head === "greeting" || head === "accent") errors[head] = issue.message;
    else errors.origins = issue.message;
  }
  return { config: null, errors };
}

/**
 * The patch a save writes over the saved binding: the parsed config, and null for each optional field
 * the form cleared, since the binding write keeps a key the patch leaves out.
 */
export function patchOf(config: WidgetBindingConfig): Record<string, unknown> {
  return { title: null, greeting: null, greetings: null, accent: null, limits: null, ...config };
}

/** The script tag a client page embeds, pointing at this web's own loader. */
export function embedSnippet(siteKey: string, webBase: string): string {
  return `<script src="${webBase}widget.js" data-site-key="${siteKey}" async></script>`;
}

/** How the client page hands its signed-in user over, queued so it works before the loader has run. */
export const IDENTIFY_SNIPPET = `<script>
  window.ForgeWidget = window.ForgeWidget || { q: [] };
  ForgeWidget.q.push(["identify", { userId: "<user id>", ts: <unix seconds>, sig: "<hex signature>" }]);
</script>`;

/** How the client's backend signs `${userId}.${ts}` with the binding's signing secret (Node). */
export const SIGNING_SNIPPET = `import { createHmac } from "node:crypto";

const ts = Math.floor(Date.now() / 1000);
const sig = createHmac("sha256", process.env.FORGE_WIDGET_SECRET)
  .update(\`\${userId}.\${ts}\`)
  .digest("hex");`;
