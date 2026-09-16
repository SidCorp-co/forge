/**
 * Unescaping the five HTML entities this repo's generated pages carry, in the
 * one order that is not lossy.
 *
 * `&amp;` goes LAST and that ordering is the whole of the module. With it
 * first, `&amp;lt;` becomes `&lt;` and is then unescaped again into `<`, so a
 * page that meant to SHOW an entity gets back the character it names, and the
 * round trip through `build-flow-map.mjs --check` disagrees with the file on
 * disk for a reason no reader of the diff can see. Every other entity here
 * produces a character no later rule matches, so `&amp;` is the only one that
 * can feed the rules below it.
 *
 * Found by CodeQL `js/double-escaping` (high), alert opened 2026-09-11 against
 * `scripts/build-flow-map.mjs:18`, fixed under ISS-1049. It lives here rather
 * than in that script because the script runs its whole build at import time,
 * so nothing could reach the function to assert on it where it was.
 */
export const unesc = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
