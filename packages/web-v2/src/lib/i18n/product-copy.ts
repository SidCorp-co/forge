import { SAID_ENTRIES, type SaidKey } from "@forge/contracts/said";
import strings from "./product-copy.json";

/**
 * The product chrome of What's new and the tours: one locale file (`product-copy.json`), each
 * language a flat map of keys, English underneath. It reads in English unless a caller names a
 * language; a key a language lacks reads in English, and a language the file lacks reads wholly in
 * English. The changelog What's new shows is written in English, so no caller names one yet.
 */
export type ProductCopyKey = keyof (typeof strings)["en"] | SaidKey;

// What core says (`@forge/contracts/said`) holds its own English, the one core's text is built
// from; the file holds only the other languages' words for those keys.
const SAID_EN = Object.fromEntries(Object.entries(SAID_ENTRIES).map(([k, e]) => [k, e.en])) as Record<SaidKey, string>;
const EN: Record<ProductCopyKey, string> = { ...strings.en, ...SAID_EN };

const LANGUAGES: Record<string, Partial<Record<ProductCopyKey, string>>> = {
  ...(strings as unknown as Record<string, Partial<Record<ProductCopyKey, string>>>),
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
