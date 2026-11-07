import type { CoreGuide } from './types.js';

export const LINK_CHAT_GUIDE: CoreGuide = {
  slug: 'link-chat-account',
  audience: 'agent',
  title: 'Linking a chat account to a Forge account',
  summary:
    'Who can link a Rocket.Chat account to a Forge user, the steps, what the person sees, how to check it worked, and what to tell them when it fails.',
  version: 2,
  body: `## Linking a chat account to a Forge account

A link says "this chat account is this Forge user". Until it exists, what a person answers in the
chat (a master's question, an act run as them) cannot be recorded as theirs. The owner's cited
answer to a Forge question is kept meanwhile, and recorded as his once the link exists.

### Who can link
- **The person themself**, on the link page: a Forge user with write access to the project and a
  verified email, the same address their chat account reports. An administrator cannot confirm it
  for them (\`SPEAKER_NOT_THE_TARGET\`): the link carries the mapped user's own authority.
- **A project admin, by naming it**, where the chat account reports no address:
  \`POST /api/projects/:id/speaker-links/named { source, externalId, userId, reason }\`. The admin
  names the Forge account by its id and says why; the naming holds in that project only, and is
  undone with \`DELETE /api/projects/:id/speaker-links/named/:namingId { reason }\`. Nothing is ever
  matched from a name.

### The owner the binding names
Never hand him the page, and never ask him to link anything or to change his chat profile. Where
his answer is refused \`SUPPORT_ANSWER_NOT_THE_OWNER\` because his account is no Forge account,
it is kept: tell the room it is noted and waits on a setup step its admins own. The refusal names
the admins. Once his account is named or linked, you are told which kept answers were recorded.

### Steps for a member
1. Call \`support.link { thread, member }\` for the person (\`member\` is their \`from.id\`; they must
   have written in that thread). \`{ linked: true }\` means there is nothing to do.
2. Otherwise you are handed a page address. Give it to the person in your own words. Do not paste
   a password or code: none exists.
3. They open it, signed in to Forge with the **same email address** their chat account reports.
   Signed out, the page asks them to sign in and then to reopen it.
4. The page shows their chat name and server, the address the chat reports, and the Forge address
   they are signed in as. They press the confirm button.

### What the person sees
A page titled "Link your chat account" and then "Chat account linked". If the two addresses do not
match exactly, the button is replaced by a notice saying so; confirming is then impossible.
You are told once it is linked; say so in the thread if they were waiting. Nothing is posted for you.

### Check it worked
Call \`support.link { thread, member }\` again: \`{ linked: true }\`. An answer of theirs refused
before and not kept can be cited again with \`support.answer_question\`. The REST pair behind the
page is \`POST /api/projects/:id/speaker-links/proposals\` (who the candidates are) and
\`POST /api/projects/:id/speaker-links\` (confirm), both as the person being linked.

### If this fails
- \`SPEAKER_EMAIL_ABSENT\`: the chat account reports no email. A project admin names their account
  instead; route it to the project's admins with \`support.route\` where nobody has.
- \`SPEAKER_ADDRESS_DIFFERS\` or \`SPEAKER_NOT_THE_TARGET\`: the chat address and their Forge address
  are not the same (same domain too, not only the part before @). A project admin can name the
  account instead.
- \`SPEAKER_ALREADY_LINKED\`: that chat account already belongs to a Forge user, possibly another,
  or a naming already stands. A naming is undone by an admin; a person's own link has no unlink door.
- \`SPEAKER_NAMED_NOT_A_MEMBER\`: the named Forge account holds no write on the project.
- No address was handed (the person never wrote in the thread): ask them to write there first.
- Known gap: a person cannot start a link themself. The page address comes only from you (the
  \`link\` act) or from a refusal that names it. If you cannot give it, say that plainly and route it
  with \`support.route\` to forge; do not invent another way.`,
};
