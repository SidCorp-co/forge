import { SAID_ENTRIES, type SaidKey } from "@forge/contracts/said";
import agentAccountsCopy from "@/features/agent-accounts/copy.json";
import agentsCopy from "@/features/agents/copy.json";
import automationCopy from "@/features/automation/copy.json";
import commentsCopy from "@/features/comments/copy.json";
import contractsCopy from "@/features/contracts/copy.json";
import conversationsCopy from "@/features/conversations/copy.json";
import ecosystemCopy from "@/features/ecosystem/copy.json";
import feedbackCopy from "@/features/feedback/copy.json";
import forecastCopy from "@/features/forecast/copy.json";
import integrationsCopy from "@/features/integrations/copy.json";
import issuesCopy from "@/features/issues/copy.json";
import memoryCopy from "@/features/memory/copy.json";
import modulesCopy from "@/features/modules/copy.json";
import needsYouCopy from "@/features/needs-you/copy.json";
import onboardingCopy from "@/features/onboarding/copy.json";
import orgsCopy from "@/features/orgs/copy.json";
import overviewCopy from "@/features/overview/copy.json";
import pipelineCopy from "@/features/pipeline/copy.json";
import projectDashboardCopy from "@/features/project-dashboard/copy.json";
import projectSettingsCopy from "@/features/project-settings/copy.json";
import projectStatusCopy from "@/features/project-status/copy.json";
import questionsCopy from "@/features/questions/copy.json";
import releasesCopy from "@/features/releases/copy.json";
import requirementsCopy from "@/features/requirements/copy.json";
import runnersCopy from "@/features/runners/copy.json";
import sessionsCopy from "@/features/sessions/copy.json";
import settingsCopy from "@/features/settings/copy.json";
import shellCopy from "@/features/shell/copy.json";
import toursCopy from "@/features/tours/copy.json";
import whatsNewCopy from "@/features/whats-new/copy.json";
import workflowsCopy from "@/features/workflows/copy.json";
import commonCopy from "@/lib/i18n/copy/common.json";
import labelCopy from "@/lib/i18n/copy/label.json";
import listCopy from "@/lib/i18n/copy/list.json";
import standingCopy from "@/lib/i18n/copy/standing.json";
import timeCopy from "@/lib/i18n/copy/time.json";
import writtenCopy from "@/lib/i18n/copy/written.json";

/**
 * The product chrome, held where each feature lives (`features/<domain>/copy.json`) and, for shared
 * chrome, in `lib/i18n/copy/<area>.json`: each file maps a language to a flat map of keys, English
 * underneath. A key's file is named by its prefix (`scripts/split-product-copy.mjs:PREFIX_HOMES`).
 * It reads in English unless a caller names a language; a key a language lacks reads in English,
 * and a language no file holds reads wholly in English.
 */
export const COPY_FILES = {
  "features/agent-accounts/copy.json": agentAccountsCopy,
  "features/agents/copy.json": agentsCopy,
  "features/automation/copy.json": automationCopy,
  "features/comments/copy.json": commentsCopy,
  "features/contracts/copy.json": contractsCopy,
  "features/conversations/copy.json": conversationsCopy,
  "features/ecosystem/copy.json": ecosystemCopy,
  "features/feedback/copy.json": feedbackCopy,
  "features/forecast/copy.json": forecastCopy,
  "features/integrations/copy.json": integrationsCopy,
  "features/issues/copy.json": issuesCopy,
  "features/memory/copy.json": memoryCopy,
  "features/modules/copy.json": modulesCopy,
  "features/needs-you/copy.json": needsYouCopy,
  "features/onboarding/copy.json": onboardingCopy,
  "features/orgs/copy.json": orgsCopy,
  "features/overview/copy.json": overviewCopy,
  "features/pipeline/copy.json": pipelineCopy,
  "features/project-dashboard/copy.json": projectDashboardCopy,
  "features/project-settings/copy.json": projectSettingsCopy,
  "features/project-status/copy.json": projectStatusCopy,
  "features/questions/copy.json": questionsCopy,
  "features/releases/copy.json": releasesCopy,
  "features/requirements/copy.json": requirementsCopy,
  "features/runners/copy.json": runnersCopy,
  "features/sessions/copy.json": sessionsCopy,
  "features/settings/copy.json": settingsCopy,
  "features/shell/copy.json": shellCopy,
  "features/tours/copy.json": toursCopy,
  "features/whats-new/copy.json": whatsNewCopy,
  "features/workflows/copy.json": workflowsCopy,
  "lib/i18n/copy/common.json": commonCopy,
  "lib/i18n/copy/label.json": labelCopy,
  "lib/i18n/copy/list.json": listCopy,
  "lib/i18n/copy/standing.json": standingCopy,
  "lib/i18n/copy/time.json": timeCopy,
  "lib/i18n/copy/written.json": writtenCopy,
};

type Words<P, L extends string> = P extends Record<L, infer W> ? keyof W & string : never;
export type ProductCopyKey = Words<(typeof COPY_FILES)[keyof typeof COPY_FILES], "en"> | SaidKey;

type Strings = Record<string, Record<string, string>>;

/** One map per language over every copy file; a key two files hold is refused, naming both. */
export function composeCopy(files: Record<string, Strings>): Strings {
  const out: Strings = {};
  const owner = new Map<string, string>();
  for (const [file, part] of Object.entries(files)) {
    for (const [lang, words] of Object.entries(part)) {
      out[lang] ??= {};
      const into = out[lang];
      for (const [key, text] of Object.entries(words)) {
        const before = owner.get(`${lang} ${key}`);
        if (before) throw new Error(`Product copy key "${key}" (${lang}) is in both ${before} and ${file}: a key lives in one copy file.`);
        owner.set(`${lang} ${key}`, file);
        into[key] = text;
      }
    }
  }
  return out;
}

/** Every language's words as the copy files hold them: what core says has only its vi here. */
export const PRODUCT_STRINGS: Strings = composeCopy(COPY_FILES as Record<string, Strings>);

// What core says (`@forge/contracts/said`) holds its own English, the one core's text is built
// from; the copy files hold only the other languages' words for those keys.
const SAID_EN = Object.fromEntries(Object.entries(SAID_ENTRIES).map(([k, e]) => [k, e.en])) as Record<SaidKey, string>;
const EN = { ...PRODUCT_STRINGS.en, ...SAID_EN } as Record<ProductCopyKey, string>;

const LANGUAGES: Record<string, Partial<Record<ProductCopyKey, string>>> = {
  ...(PRODUCT_STRINGS as Record<string, Partial<Record<ProductCopyKey, string>>>),
  en: EN,
};

/** The base language of a BCP-47 tag: `vi-VN` reads as `vi`. */
export function baseOf(tag: string | null | undefined): string {
  return (tag ?? "en").toLowerCase().split("-")[0] ?? "en";
}

export type Copy = (key: ProductCopyKey, vars?: Record<string, string | number>) => string;

/** A reader of the chrome in `language`, filling `{name}` slots from `vars`. */
export function productCopy(language?: string | null): Copy {
  const own = LANGUAGES[baseOf(language)] ?? {};
  return (key, vars) => {
    const template = own[key] ?? EN[key];
    return vars ? template.replace(/\{(\w+)\}/g, (slot, name: string) => String(vars[name] ?? slot)) : template;
  };
}

/** The locale dates and day names are written in for `language`. */
export function copyLocale(language?: string | null): string {
  return baseOf(language) === "vi" ? "vi-VN" : "en-GB";
}

/** A key the type does not name (an enum value's label): the language's text, else `fallback`. */
export function copyOr(language: string | null | undefined, key: string, fallback: string): string {
  return LANGUAGES[baseOf(language)]?.[key as ProductCopyKey] ?? fallback;
}

/** `key`'s own template in `language`, else its English; undefined for a key no language holds. */
export function productCopyTemplate(language: string | null | undefined, key: string): string | undefined {
  return LANGUAGES[baseOf(language)]?.[key as ProductCopyKey] ?? EN[key as ProductCopyKey];
}
