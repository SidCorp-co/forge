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
