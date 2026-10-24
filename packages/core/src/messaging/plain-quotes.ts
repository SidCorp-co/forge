const APOSTROPHES = /[\u2018\u2019\u201A\u201B\u2032\u02BC\uFF07\u00B4]/g;
const QUOTATION_MARKS = /[\u201C\u201D\u201E\u201F\u2033\uFF02]/g;

export function plainQuotes(text: string): string {
  return text.replace(APOSTROPHES, "'").replace(QUOTATION_MARKS, '"');
}
