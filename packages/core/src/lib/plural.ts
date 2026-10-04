// cm:why a sentence core composes around a count agrees with that count through these two, so a builder cannot print "1 reason stand" or "ISS-1 have" by writing only its plural (ISS-71)

export function agrees(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

export function counted(n: number, one: string, many = `${one}s`): string {
  return `${n} ${agrees(n, one, many)}`;
}
