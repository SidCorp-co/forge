export function counted(n: number, noun: string, plural = `${noun}s`): string {
  return `${n} ${n === 1 ? noun : plural}`;
}

export function agree(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** Every one of `n`, as a person says it: "the one issue", "both issues", "all 3 issues". */
export function everyOne(n: number, noun: string, plural = `${noun}s`): string {
  if (n === 1) return `the one ${noun}`;
  return n === 2 ? `both ${plural}` : `all ${n} ${plural}`;
}

/** "ISS-1", "ISS-1 and ISS-2", "ISS-1, ISS-2 and ISS-3". */
export function namesInWords(ids: readonly string[]): string {
  return ids.length < 2
    ? ids.join('')
    : `${ids.slice(0, -1).join(', ')} and ${ids[ids.length - 1]}`;
}

/** "ISS-5 and ISS-4" for a reader who named none of them, or "2 issues" where no name was read. */
export function issuesByName(details: Record<string, unknown>): string {
  const ids = Array.isArray(details.issueIds) ? details.issueIds : [];
  const shown = Array.isArray(details.displayIds)
    ? details.displayIds.filter((id): id is string => typeof id === 'string')
    : [];
  return shown.length > 0 && shown.length === ids.length
    ? namesInWords(shown)
    : counted(ids.length, 'issue');
}
