/**
 * A captions track for a recording with no spoken words: its text alternative, shown for its whole
 * length, as a WebVTT data URL a `<track kind="captions">` can load.
 */
export function captionsOf(text: string): string {
  return `data:text/vtt;charset=utf-8,${encodeURIComponent(`WEBVTT\n\n00:00:00.000 --> 99:59:59.000\n${text}\n`)}`;
}
