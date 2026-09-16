// Markdown normalisation shared by the checkers that ask "is this text on the page?".
// Both rules below were learned from a measured false green in `check-honest-costs`, and both
// apply verbatim to any other gate matching a heading or a bullet — `check-release-record` was
// written with its own fence tracker and no comment handling, so it still counted a
// `<!-- - ISS-000 … -->` entry as published. One copy, so the next CommonMark correction lands once.

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

export function withoutComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, '');
}
