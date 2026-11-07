import { SAID_ENTRIES, type SaidKey } from "@forge/contracts/said";
import { COPY_FILES } from "./copy-files";

// The product chrome, composed from the copy files (`./copy-files`), in English. Forge is English only
// (the owner's ruling of 2026-10-08, ISS-1071): a copy file holds one block, `en`, and a block in any
// other language is refused by name when the copy is composed. A reader asked for a language other than
// English throws naming it, rather than drawing English in its place: no screen asks for one any more,
// so a caller that does is a defect to see, never a page to draw.

type Words<P> = P extends Record<"en", infer W> ? keyof W & string : never;
export type ProductCopyKey = Words<(typeof COPY_FILES)[keyof typeof COPY_FILES]> | SaidKey;

/** The one language the chrome is written in. */
export type InterfaceLanguage = "en";

type Strings = Record<string, Record<string, string>>;

/** The English map over every copy file; a key two files hold, or a block in another language, is refused naming the file. */
export function composeCopy(files: Record<string, Strings>): { en: Record<string, string> } {
  const en: Record<string, string> = {};
  const owner = new Map<string, string>();
  for (const [file, part] of Object.entries(files)) {
    for (const lang of Object.keys(part)) {
      if (lang !== "en") throw new Error(`Product copy file ${file} holds a "${lang}" block: Forge is English only (owner, 2026-10-08), so a copy file holds "en" alone.`);
    }
    for (const [key, text] of Object.entries(part.en ?? {})) {
      const before = owner.get(key);
      if (before) throw new Error(`Product copy key "${key}" (en) is in both ${before} and ${file}: a key lives in one copy file.`);
      owner.set(key, file);
      en[key] = text;
    }
  }
  return { en };
}

/** The copy files' English: what core says holds its own English in `@forge/contracts/said`, never here. */
export const PRODUCT_STRINGS = composeCopy(COPY_FILES);

const SAID_EN = Object.fromEntries(Object.entries(SAID_ENTRIES).map(([k, e]) => [k, e.en])) as Record<SaidKey, string>;
const EN = { ...PRODUCT_STRINGS.en, ...SAID_EN } as Record<ProductCopyKey, string>;

/** The base language of a BCP-47 tag: `en-GB` reads as `en`. */
export function baseOf(tag: string | null | undefined): string {
  return (tag ?? "en").toLowerCase().split("-")[0] ?? "en";
}

/** `language` where it is English (or unnamed); any other is refused by name, never read as English. */
export function englishOnly(language?: string | null): InterfaceLanguage {
  if (language == null || baseOf(language) === "en") return "en";
  throw new Error(`No product copy is written in "${language}": Forge is English only (owner, 2026-10-08, ISS-1071).`);
}

export type Copy = (key: ProductCopyKey, vars?: Record<string, string | number>) => string;

/** A reader of the chrome, filling `{name}` slots from `vars`. */
export function productCopy(language?: string | null): Copy {
  englishOnly(language);
  return (key, vars) => {
    const template = EN[key];
    return vars ? template.replace(/\{(\w+)\}/g, (slot, name: string) => String(vars[name] ?? slot)) : template;
  };
}

/** The locale dates and day names are written in: en-GB, a 24-hour clock with the day before the month. */
export function copyLocale(language?: string | null): string {
  englishOnly(language);
  return "en-GB";
}

/** A key the type does not name (an enum value's label): its English, else `fallback`. */
export function copyOr(language: string | null | undefined, key: string, fallback: string): string {
  englishOnly(language);
  return EN[key as ProductCopyKey] ?? fallback;
}

/** `key`'s English template; undefined for a key no copy file and no registry entry holds. */
export function productCopyTemplate(language: string | null | undefined, key: string): string | undefined {
  englishOnly(language);
  return EN[key as ProductCopyKey];
}
