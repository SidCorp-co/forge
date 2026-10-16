export function counted(n: number, noun: string, plural = `${noun}s`): string {
  return `${n} ${n === 1 ? noun : plural}`;
}

export function agree(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}
