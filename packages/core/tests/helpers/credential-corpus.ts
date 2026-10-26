// Text on both sides of every pattern the credential screen reads, and the near misses beside each, shared
// by the migrations that restate that screen in SQL (0378, 0380) so each is held to the same answer.

export const SECRET = 'Zq8VtR2mK9xLp4Wd';

const stdoutOf = (value: unknown) =>
  JSON.stringify({ exitCode: 0, stdout: JSON.stringify(value, null, 2) });

export const PROSE = [
  `Sign in at https://app.example.com/cb?token=${SECRET} to finish.`,
  `Open https://app.example.com/cb?page=2&API_KEY=${SECRET}#top`,
  'Open https://app.example.com/cb?tokens=2 for the list.',
  'Open https://app.example.com/cb?token=&page=2 for the list.',
  `The deploy password: ${SECRET} is in the vault.`,
  `{"accessToken": "${SECRET}"}`,
  'The password reset link is on the login page.',
  'Set password: "" to clear it.',
  'my_token: abc is a variable name.',
  'The tokenizer: splits words.',
  `Authorization: Bearer ${SECRET}`,
  'Authorization is required for this call.',
  'authorization:\r\nnext line',
  `curl -H "X-Api-Key=${SECRET}" https://example.com`,
  `Use forge_pat_prd_${'ab12'.repeat(8)} for the call.`,
  'The prefix forge_pat_dev_ starts every token.',
  `ya29.${SECRET} is the access token.`,
  'ya29 is a prefix.',
  '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----',
  '-----BEGIN PUBLIC KEY-----\nMIIBIj\n-----END PUBLIC KEY-----',
  `export DB_PASSWORD=${SECRET}`,
  `Two lines\n  STRIPE_SECRET_KEY = ${SECRET}\nend`,
  'DB_PASSWORD=hunter2\r\nnext',
  `The password:\u00a0${SECRET} line.`,
  `export\u00a0GH_TOKEN=${SECRET}`,
  'GH_TOKEN=\u2028',
  'DB_PASSWORD=',
  'db_password=lowercase is not an env line',
  'ISS-4242 shipped in v9.2.',
  "**ISS-999** is not on this project's tracker.",
];

/** What a tool hands back: JSON, a secret as a quoted key, escaped inside a string, or on a line of one. */
export const JSON_SHAPED = [
  JSON.stringify({ password: SECRET }),
  JSON.stringify({ environments: [{ label: 'staging', token: SECRET }] }),
  JSON.stringify({ Authorization: `Bearer ${SECRET}` }),
  JSON.stringify({ password: '' }),
  JSON.stringify({ tokens: 5, tokenizer: 'words' }),
  stdoutOf({ issueId: 'ISS-2', description: `Build at https://ci.test/run?token=${SECRET}` }),
  stdoutOf({ issueId: 'ISS-2', description: `Set\nDB_PASSWORD=${SECRET}\nthen run it.` }),
  stdoutOf({ issueId: 'ISS-2', token: SECRET }),
  stdoutOf({ issueId: 'ISS-2', title: 'Build link for the nightly run' }),
  '[1, 2, 3]',
  '{this} is not JSON',
];

/**
 * JSON that JavaScript reads and Postgres's `jsonb` cannot: 0380 clears it whole, unread, so the SQL
 * clears more here than the runtime screen, never less.
 */
export const UNDECODABLE_IN_SQL = ['{"note": "a\\u0000b"}', '{"note": "\\ud800 alone"}'];
