// snappyjs ships no types: the two functions the remote-write door reads it by (ISS-1225).
declare module 'snappyjs' {
  export function uncompress(compressed: Uint8Array, maxLength?: number): Uint8Array;
  export function compress(uncompressed: Uint8Array): Uint8Array;
}
