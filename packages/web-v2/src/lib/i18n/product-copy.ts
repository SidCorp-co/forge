import strings from "./product-copy.json";

/**
 * The product chrome of What's new and the tours: one locale file (`product-copy.json`), each
 * language a flat map of keys, English underneath. It reads in English unless a caller names a
 * language; a key a language lacks reads in English, and a language the file lacks reads wholly in
 * English. The changelog What's new shows is written in English, so no caller names one yet.
 */
export type ProductCopyKey = keyof (typeof strings)["en"];

const LANGUAGES = strings as unknown as Record<string, Partial<Record<ProductCopyKey, string>>>;

/** The base language of a BCP-47 tag: `vi-VN` reads as `vi`. */
export function baseOf(tag: string | null | undefined): string {
  return (tag ?? "en").toLowerCase().split("-")[0] ?? "en";
}

export type Copy = (key: ProductCopyKey, vars?: Record<string, string | number>) => string;

/** A reader of the chrome in `language`, filling `{name}` slots from `vars`. */
export function productCopy(language?: string | null): Copy {
  const own = LANGUAGES[baseOf(language)] ?? {};
  const en = strings.en;
  return (key, vars) => {
    const template = own[key] ?? en[key];
    return vars ? template.replace(/\{(\w+)\}/g, (slot, name: string) => String(vars[name] ?? slot)) : template;
  };
}

/** The locale dates and day names are written in for `language`. */
export function copyLocale(language?: string | null): string {
  return baseOf(language) === "vi" ? "vi-VN" : "en-GB";
}
