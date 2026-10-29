// What a switch duty may not name (ISS-775, REQ-77 BC-22): the confined channel agent sees no file of
// the box, no key and no host, so a duty worded as the outside bot did it there — a handover file, a
// key, a shell on a production host — can never be passed by the agent. Each duty names the Forge
// door the agent does it through instead.

const READS: readonly { what: string; pattern: RegExp }[] = [
  {
    what: 'the box path',
    pattern: /(?:^|[\s"'`(=:])((?:~|\/(?:home|root|etc|var|opt|srv|usr|tmp|mnt))(?:\/[\w.@+-]+)+)/,
  },
  { what: 'the key', pattern: /\b(id_(?:rsa|ed25519|ecdsa|dsa)\b|[\w-]+\.(?:pem|key|p12|pfx)\b)/i },
  { what: 'the credential file', pattern: /\b(credentials\.json|\.env\b|ssh[- ]key|private key)/i },
  { what: 'the shell', pattern: /\b(ssh|scp|rsync|tmux)\b/i },
  { what: 'the host', pattern: /\b(\d{1,3}(?:\.\d{1,3}){3})\b/ },
  {
    what: 'the host',
    pattern: /\b((?:[a-z0-9-]+\.)+(?:com|co|io|net|org|vn|dev|app|cloud|xyz|sh|internal|local))\b/i,
  },
];

/** What of the box a duty's text names, as `the box path /home/dev/x`, or null where it names none. */
export function boxReachIn(text: string): string | null {
  for (const { what, pattern } of READS) {
    const found = pattern.exec(text);
    if (found?.[1]) return `${what} ${found[1]}`;
  }
  return null;
}
