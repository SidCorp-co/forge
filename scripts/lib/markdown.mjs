// Markdown normalisation shared by the checkers that ask "is this text on the page?".
// Both rules below were learned from a measured false green in `check-honest-costs`, and both
// apply verbatim to any other gate matching a heading or a bullet — `check-release-record` was
// written with its own fence tracker and no comment handling, so it still counted a
// `<!-- - ISS-000 … -->` entry as published. One copy, so the next CommonMark correction lands once.

// cm:guard a fenced block is not content. `## Honest costs` inside a ```md example satisfied the heading match while the document itself priced nothing — the published rule refuses an absent section, and a section that exists only as an illustration of the rule is absent.
// cm:guard close on the OPENING marker's char and length, per CommonMark — a toggle that flips on any fence line reopens the block at the inner ````` of a nested example, and the illustrated section reads as a real one again. An unclosed fence swallowing the rest of the document is not a bug here: that is what a renderer shows the reader, and the gate must agree with the page rather than with the source.
// cm:guard blank the line, never drop it — `check-release-record` reports the line a violation sits on, and deleting fenced lines would shift every number below them.
export function withoutFences(text) {
  let open = null;
  return text
    .split('\n')
    .map((line) => {
      const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (fence) {
        const [char, len] = [fence[1][0], fence[1].length];
        if (open === null) {
          open = { char, len };
          return '';
        }
        if (char === open.char && len >= open.len) open = null;
        return '';
      }
      return open ? '' : line;
    })
    .join('\n');
}

// cm:why a commented-out heading is not on the page either, and `<!-- ## Honest costs -->` satisfied the match — same false green as the fenced example, one syntax over
export function withoutComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, '');
}
