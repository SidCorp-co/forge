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
