import { SAID_ENTRIES, type SaidKey } from "@forge/contracts/said";
import { COPY_FILES } from "./copy-files";

// The product chrome, composed from the copy files (`./copy-files`), English underneath. It reads in
// English unless a caller names a language; a key a language lacks reads in English, and a language
// no file holds reads wholly in English. Forge is not multilingual (the owner's ruling of 2026-10-08):
// the vi words already written stay, and a new key is written in English only.

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
