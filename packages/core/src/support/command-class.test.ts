import { supportGrantsSchema } from '@forge/contracts/support';
import { describe, expect, it } from 'vitest';
import { classifyCommand } from './command-class.js';
import { isConfirmer } from './grants.js';

// REQ-75 r5 BC-27: a command that only reads runs at once, anything else waits for a confirmer.
// The rule leans to "changes": a wrong change costs a confirm, a wrong read costs the host.

describe('a command on a host reads, or waits for a confirmer', () => {
  it.each([
    'systemctl status stalwart',
    'journalctl -u stalwart -n 200 --no-pager',
    'ss -tlnp',
    'dig +short -x 67.220.215.42',
    'cat /etc/stalwart/config.toml',
    'postqueue -p',
    'mailq',
    'journalctl -u postfix -n 50 | grep -i reject | tail -n 20',
    'tail -n 100 /var/log/mail.log',
    'ping -c 3 mta1',
    'hostname -f',
    '/usr/bin/cat /etc/hostname',
    'sort -u /etc/hosts | uniq -c',
    'openssl x509 -in /etc/ssl/c.pem -noout -dates',
  ])('reads: %s', (command) => {
    expect(classifyCommand(command)).toEqual({ reads: true });
  });

  it.each([
    ['systemctl restart stalwart', 'can write'],
    ['journalctl --vacuum-time=1d', 'can write'],
    ['tail -f /var/log/mail.log', 'can write or never end'],
    ['cat /etc/passwd > /tmp/x', 'shell construct'],
    ['ls; rm -rf /var/lib/stalwart', 'shell construct'],
    ['echo $(id)', 'shell construct'],
    ['ls && reboot', 'shell construct'],
    ['postsuper -d ALL', 'not a program known only to read'],
    ['sudo systemctl status x', 'another user'],
    ['find /var -delete', 'can write'],
    ["sed -i 's/a/b/' /etc/x", 'not a program known only to read'],
    ["sed -n '1e touch /tmp/support-write' /etc/hosts", 'not a program known only to read'],
    ["awk 'BEGIN{print 1}' /etc/hosts", 'shell construct'],
    ['uniq /etc/hosts /tmp/support-copy', 'can write'],
    ['tail -fn 100 /var/log/mail.log', 'can write'],
    ['journalctl -xef', 'can write'],
    ['sort --compress-program=sh /etc/hosts', 'can write'],
    ['ip netns exec blue id', 'can write'],
    ['hostname -F /tmp/name', 'can write'],
    ['openssl x509 -in /etc/ssl/c.pem -out /tmp/c.pem', 'can write'],
    ['file -C -m /tmp/magic', 'can write'],
    ['/tmp/planted/cat /etc/hosts', 'not a system program'],
    ['less /var/log/mail.log', 'not a program known only to read'],
    ['ip route add 10.0.0.0/8 via 1.2.3.4', 'can write'],
    ['hostname newname', 'can write'],
    ['ping mta1', 'never end'],
    ['curl -X POST https://x', 'not a program known only to read'],
  ])('changes: %s', (command, why) => {
    const got = classifyCommand(command);
    expect(got.reads).toBe(false);
    expect(got.reads ? '' : got.why).toContain(why);
  });
});

describe('a room grant names what its targeted abilities reach (BC-27)', () => {
  const ok = (g: unknown) => supportGrantsSchema.safeParse(g).success;
  const why = (g: unknown) => {
    const r = supportGrantsSchema.safeParse(g);
    return r.success ? '' : r.error.issues.map((i) => i.message).join('; ');
  };

  it('takes the four rooms of BC-29 as they are bound', () => {
    expect(ok({ abilities: ['read_checkout', 'file_items'] })).toBe(true);
    expect(
      ok({
        abilities: ['read_checkout', 'file_items', 'deliver', 'build', 'run_commands'],
        hosts: ['mail-01', 'mta1', 'mta6'],
        confirmers: ['chuongld', 'thanhnh'],
      }),
    ).toBe(true);
  });

  it('refuses an ability without what it reaches, or a reach without its ability', () => {
    expect(why({ abilities: ['run_commands'], confirmers: ['a'] })).toContain('names no host');
    expect(why({ abilities: [], hosts: ['mta1'] })).toContain('run_commands is not granted');
    expect(why({ abilities: ['deploy'], confirmers: ['a'] })).toContain('names no deploy target');
    expect(why({ abilities: ['build'] })).toContain('wait for a confirmer');
    expect(why({ abilities: ['file_items', 'file_items'] })).toContain('named once');
    expect(
      why({ abilities: ['run_commands'], hosts: ['-oProxyCommand=x'], confirmers: ['a'] }),
    ).toContain('host name');
  });

  it('counts a confirm only from a confirmer the grant names, by the signed username', () => {
    const g = { abilities: ['build' as const], confirmers: ['chuongld', 'thanhnh'] };
    expect(isConfirmer(g, 'chuongld')).toBe(true);
    expect(isConfirmer(g, 'ThanhNH')).toBe(true);
    expect(isConfirmer(g, 'tands')).toBe(false);
    expect(isConfirmer(g, null)).toBe(false);
    expect(isConfirmer({ abilities: [] }, 'chuongld')).toBe(false);
  });
});
