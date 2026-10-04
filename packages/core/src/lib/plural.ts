export function agrees(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

export function counted(n: number, one: string, many = `${one}s`): string {
  return `${n} ${agrees(n, one, many)}`;
}
