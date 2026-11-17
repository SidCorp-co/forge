import { WIDGET_LANGUAGES, type WidgetLanguage, type WidgetPublicConfig, widgetGreetingOf, widgetLanguageOf } from "@forge/contracts/widget";
import { createContext, type ReactNode, use, useEffect, useMemo } from "react";
import { type ProductCopyKey, productCopy } from "@/lib/i18n/product-copy";
import viFile from "./copy-vi.json";

// The widget is a surface another product's end users see, not Forge's own chrome, so it speaks the
// language its host page names (`ForgeWidget.setContext({ locale })`, else the browser's), where
// Forge's chrome is English only (ISS-1071). Its English is the product copy's `widget.*` keys
// (`lib/i18n/copy/widget.json`); every other language it writes is a file beside this one, holding
// every one of those keys. A locale the widget writes no copy in is drawn in English and named in a
// console warning, never swapped silently.

export type WidgetCopyKey = Extract<ProductCopyKey, `widget.${string}`>;
export type WidgetCopy = (key: WidgetCopyKey, vars?: Record<string, string | number>) => string;

/** Each written language but English, every widget key in it. */
export const WIDGET_WORDS: Record<Exclude<WidgetLanguage, "en">, Record<WidgetCopyKey, string>> = { vi: viFile.vi };

/** A reader of the widget's own words in `language`, filling `{name}` slots from `vars`. */
export function widgetCopy(language: WidgetLanguage): WidgetCopy {
  if (language === "en") return productCopy("en");
  const words = WIDGET_WORDS[language];
  return (key, vars) => {
    const template = words[key];
    return vars ? template.replace(/\{(\w+)\}/g, (slot, name: string) => String(vars[name] ?? slot)) : template;
  };
}

const WidgetLanguageContext = createContext<WidgetLanguage>("en");

/** The widget's words, in the language the host page named; English outside a `WidgetLanguage`. */
export function useWidgetCopy(): WidgetCopy {
  const language = use(WidgetLanguageContext);
  return useMemo(() => widgetCopy(language), [language]);
}

/** The site's greeting in the visitor's language, else its one greeting; null where it wrote none. */
export function useWidgetGreeting(config: WidgetPublicConfig): string | null {
  return widgetGreetingOf(config, use(WidgetLanguageContext));
}

/** Draws `children` in the language `locale` names, warning once per locale the widget writes no copy in. */
export function WidgetLocale({ locale, children }: { locale: string | null | undefined; children: ReactNode }) {
  const written = widgetLanguageOf(locale);
  useEffect(() => {
    if (written === null)
      console.warn(`[forge-widget] no copy is written in locale "${locale}"; the widget shows English (written: ${WIDGET_LANGUAGES.join(", ")}).`);
  }, [locale, written]);
  return <WidgetLanguageContext value={written ?? "en"}>{children}</WidgetLanguageContext>;
}
