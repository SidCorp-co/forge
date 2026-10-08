/**
 * A language tag (`vi`, `vi-VN`, `en-GB`) as the language Forge writes its own lines in: Vietnamese
 * by its base language, anything else English. A person's preference and a project's content
 * language both read through this one rule, as the web reads its chrome
 * (`web-v2/src/lib/i18n/product-copy.ts:baseOf`).
 */
export function languageOfTag(tag: string | null | undefined): 'en' | 'vi' {
  return tag?.toLowerCase().split('-')[0] === 'vi' ? 'vi' : 'en';
}
