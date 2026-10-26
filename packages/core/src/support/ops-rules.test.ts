import { chatRoleSchema, operationsRoomConfigSchema } from '@forge/contracts/support-operations';
import { describe, expect, it } from 'vitest';
import { settleSupportRoom } from '../integrations/rocketchat/support-binding.js';
import { isPublicAddress, pageText, readPublicPage } from './ops-research.js';
import { grantRefusal } from './ops-role.js';

const SY = {
  name: 'sy',
  persona: 'Sy drafts product direction for a person.',
  grants: ['read', 'draft', 'research'],
} as const;

describe('an operations role (REQ-75 BC-22..BC-24)', () => {
  it('admits what it is granted and refuses the rest naming the grant', () => {
    const role = chatRoleSchema.parse(SY);
    expect(grantRefusal(role, 'issues')).toBeNull();
    expect(grantRefusal(role, 'draft_requirement')).toBeNull();
    const refused = grantRefusal(role, 'move');
    expect(refused?.ok).toBe(false);
    const [r] = refused && !refused.ok ? refused.refusals : [];
    expect(r?.code).toBe('OPS_ROLE_NOT_GRANTED');
    expect(r?.detail).toContain('the sy role is not granted `deliver`');
  });

  it('refuses a role naming a grant twice, none, or one that does not exist', () => {
    expect(chatRoleSchema.safeParse({ ...SY, grants: ['read', 'read'] }).success).toBe(false);
    expect(chatRoleSchema.safeParse({ ...SY, grants: [] }).success).toBe(false);
    expect(chatRoleSchema.safeParse({ ...SY, grants: ['admin'] }).success).toBe(false);
    expect(chatRoleSchema.safeParse({ ...SY, name: 'Sy Bot' }).success).toBe(false);
  });

  it('takes a scope of forge or project, and nothing else', () => {
    expect(operationsRoomConfigSchema.safeParse({ scope: 'forge' }).success).toBe(true);
    expect(operationsRoomConfigSchema.safeParse({ scope: 'org' }).success).toBe(false);
    expect(operationsRoomConfigSchema.safeParse({ scope: 'project', x: 1 }).success).toBe(false);
  });
});

describe('a binding attaching rooms', () => {
  it('refuses support and operations on one binding, by name', async () => {
    const out = await settleSupportRoom({
      bindingId: 'b',
      config: { rids: ['r1'], support: {}, operations: { scope: 'forge' } },
      held: null,
    });
    expect(out.ok ? null : out.refusals[0]?.code).toBe('SUPPORT_ROOM_TWO_KINDS');
  });

  it('lets an operations binding attach several rooms, and a support binding only one', async () => {
    const ops = await settleSupportRoom({
      bindingId: 'b',
      config: { rids: ['r1', 'r2'], operations: { scope: 'project' } },
      held: null,
    });
    expect(ops.ok).toBe(true);
    const support = await settleSupportRoom({
      bindingId: 'b',
      config: { rids: ['r1', 'r2'], support: {} },
      held: null,
    });
    expect(support.ok ? null : support.refusals[0]?.code).toBe('SUPPORT_ROOM_NOT_ONE_GROUP');
  });
});

describe('research reads only a public page (REQ-75 BC-24)', () => {
  it.each([
    ['127.0.0.1', false],
    ['10.1.2.3', false],
    ['172.20.0.1', false],
    ['192.168.1.1', false],
    ['169.254.169.254', false],
    ['100.64.0.1', false],
    ['0.0.0.0', false],
    ['::1', false],
    ['fd00::1', false],
    ['fe80::1', false],
    ['::ffff:127.0.0.1', false],
    ['::ffff:7f00:1', false],
    ['::ffff:93.184.215.14', true],
    ['not-an-ip', false],
    ['93.184.215.14', true],
    ['2606:4700::6810:84e5', true],
  ])('%s is public: %s', (address, publicOne) => {
    expect(isPublicAddress(address)).toBe(publicOne);
  });

  it.each([
    ['http://example.com/', 'only an https page'],
    ['https://example.com:8443/', 'port 443'],
    ['https://user:pw@example.com/', 'credentials'],
    ['https://127.0.0.1/', 'not a public address'],
    ['https://[::1]/', 'not a public address'],
  ])('refuses %s before any byte is sent', async (url, why) => {
    const out = await readPublicPage(url);
    expect(out.ok).toBe(false);
    expect(out.ok ? '' : out.refusals[0]?.detail).toContain(why);
  });

  it('keeps a page’s visible words and drops its scripts, styles and tags', () => {
    expect(
      pageText(
        '<html><head><style>p{}</style><script>alert(1)</script></head><body><h1>Title</h1><p>One &amp; two</p></body></html>',
      ),
    ).toBe('Title\nOne & two');
  });
});
