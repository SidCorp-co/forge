// Whether a command a room's session asks to run on a host only reads (REQ-75 r5 BC-27). A command
// that only reads runs at once; anything else changes the host and waits for a confirmer. The rule
// is deliberately narrow: a command reads only when every stage of it is a program this list knows
// to read, with arguments that keep it reading, and the line holds no shell construct that could
// write, chain or substitute. Whatever this cannot tell reads, it treats as a change — a wrong
// "change" costs a confirm, a wrong "read" would cost the host.

/** Shell constructs that write, chain, substitute or background: none appears in a reading command. */
const SHELL_WRITES = /[;&><`$(){}\\\n\r]|\|\|/;

/**
 * The flags that would make a program write or never end, as its parser reads them: a short one
 * anywhere in a cluster (`-uo`, `-xef`), with its value attached or not, and a long one by any prefix
 * getopt_long takes for it (`--out` is `--output`, `--fol` is `--follow`).
 */
function flags(short: string, ...long: string[]): RegExp {
  const prefix = (name: string) =>
    `--${name[0]}${[...name.slice(1)].map((c) => `(?:${c}`).join('')}${')?'.repeat(name.length - 1)}`;
  const longs = long.map(prefix).join('|');
  const shorts = short ? `-[A-Za-z0-9]*[${short}]` : null;
  const either = [shorts, longs ? `(?:${longs})(?=[=\\s]|$)` : null].filter(Boolean).join('|');
  return new RegExp(`(^|\\s)(?:${either})`);
}
const FOLLOW = flags('fF', 'follow', 'retry');
/** Any operand that is not a flag: what a filter that would write its second operand must not take. */
const AN_OPERAND = /(^|\s)[^-\s]/;

/**
 * Programs that only read, each with the arguments that would make it write, run another program or
 * never end. A program that can write through an operand or a script of its own (sed, awk, curl,
 * less, tee) is not here at all: it waits for a confirmer.
 */
const READERS: Record<string, { refuse?: RegExp }> = {
  cat: {},
  head: {},
  tail: { refuse: FOLLOW },
  grep: {},
  zgrep: {},
  egrep: {},
  wc: {},
  ls: {},
  stat: {},
  file: { refuse: flags('C', 'compile') },
  find: { refuse: /(^|\s)-(delete|exec|execdir|ok|okdir|fprint\w*|fls)\b/ },
  du: {},
  df: {},
  free: { refuse: flags('sc', 'seconds', 'count') },
  uptime: {},
  uname: {},
  hostname: {
    refuse:
      /^(?!\s*(-[fsiIdA]|--fqdn|--long|--short|--ip-address|--all-ip-addresses|--domain|--all-fqdns)?\s*$)/,
  },
  date: { refuse: flags('s', 'set') },
  whoami: {},
  id: {},
  ps: {},
  ss: { refuse: flags('KE', 'kill', 'events') },
  netstat: { refuse: flags('c', 'continuous') },
  // ip takes any prefix of a verb (`s` is `set` for a link), so only showing an object is a read
  ip: {
    refuse:
      /^(?!\s*(-(br|brief|4|6|s|stats|d|details|c|color|j|json|p|pretty|o|oneline|h|human)\s+)*(a|addr|address|l|link|r|route|n|neigh|neighbour|ru|rule|maddr)(\s+(show|list|ls)(\s+(dev|table|scope|to|from|type|up)\b(\s+[A-Za-z0-9._:/-]+)?)*)?\s*$)/,
  },
  dig: {},
  host: {},
  nslookup: {},
  ping: { refuse: /^(?!.*(^|\s)-c\s*\d).*$/ },
  journalctl: {
    refuse: flags(
      'f',
      'follow',
      'vacuum-size',
      'vacuum-time',
      'vacuum-files',
      'rotate',
      'flush',
      'sync',
      'relinquish-var',
      'smart-relinquish-var',
      'setup-keys',
      'update-catalog',
    ),
  },
  systemctl: {
    refuse:
      /^(?!\s*(status|is-active|is-enabled|is-failed|show|list-units|list-unit-files|list-timers|cat)\b)/,
  },
  mailq: {},
  postqueue: { refuse: /^(?!\s*-p\s*$)/ },
  // s_client ends when its empty stdin does; x509 reads unless it signs (and writes a serial file)
  openssl: {
    refuse:
      /^(?!\s*(s_client|x509|version)\b)|(^|\s)-(out|sess_out|keylogfile|msgfile|writerand|engine|req|CA\w*|signkey|set_serial|force_pubkey|new\w*)(?=\s|$)/,
  },
  sort: { refuse: flags('o', 'output', 'compress-program') },
  uniq: { refuse: AN_OPERAND },
  cut: {},
  jq: {},
};

/** Where a program named by its path may live; anywhere else it may be a script planted under a known name. */
const SYSTEM_BIN = /^\/(usr\/)?s?bin\/[^/]+$/;

export type CommandClass = { reads: true } | { reads: false; why: string };

/** Whether `command` only reads, and when not, the first reason it may change the host. */
export function classifyCommand(command: string): CommandClass {
  if (SHELL_WRITES.test(command)) {
    return {
      reads: false,
      why: 'it holds a shell construct that can write, chain or substitute (; & > < ` $ ( ) { } \\ || or a new line)',
    };
  }
  for (const stage of command.split('|')) {
    // the remote shell drops quotes before a program reads its words (`'-o'` is `-o`), and with no
    // `$`, backtick or backslash left a quote can only group words: judge them as the program sees them
    const words = stage.replace(/['"]/g, '').trim().split(/\s+/);
    const named = words[0] ?? '';
    if (named.includes('/') && !SYSTEM_BIN.test(named)) {
      return { reads: false, why: `${named} is not a system program` };
    }
    const program = named.replace(/^.*\//, '');
    const rest = words.slice(1).join(' ');
    if (program === 'sudo') return { reads: false, why: 'it runs as another user (sudo)' };
    const reader = READERS[program];
    if (!reader)
      return {
        reads: false,
        why: `${program || 'an empty stage'} is not a program known only to read`,
      };
    if (reader.refuse?.test(rest)) {
      return { reads: false, why: `${program} ${rest} can write or never end` };
    }
  }
  return { reads: true };
}
