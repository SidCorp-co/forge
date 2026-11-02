import type { CoreGuide } from './types.js';

export const LINK_CHAT_GUIDE: CoreGuide = {
  slug: 'link-chat-account',
  audience: 'agent',
  title: 'Linking a chat account to a Forge account',
  summary:
    'Who can link a Rocket.Chat account to a Forge user, the steps, what the person sees, how to check it worked, and what to tell them when it fails.',
  version: 1,
  body: `## Linking a chat account to a Forge account

A link says "this chat account is this Forge user". Until it exists, what a person answers in the
chat (a master's question, an act run as them) is kept as a refusal, not as theirs.

### Who can link
Only the person themself. They must be a Forge user with write access to the project and a
verified email. An administrator cannot confirm it for them: the link carries the mapped user's
own authority, so core refuses a confirmation signed in as anyone else
(\`SPEAKER_NOT_THE_TARGET\`). An admin can only help by sorting out the email addresses.

### Steps
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
Call \`support.link { thread, member }\` again: \`{ linked: true }\`. The person may then answer
the waiting question again in the thread. The REST pair behind the page is
\`POST /api/projects/:id/speaker-links/proposals\` (who the candidates are) and
\`POST /api/projects/:id/speaker-links\` (confirm), both as the person being linked.

### If this fails
- \`SPEAKER_EMAIL_ABSENT\`: the chat account reports no email. They set one on the chat account.
- \`SPEAKER_ADDRESS_DIFFERS\` or \`SPEAKER_NOT_THE_TARGET\`: the chat address and their Forge address
  are not the same. Make them the same on either side (same domain too, not only the part before @),
  then reopen the page.
- \`SPEAKER_ALREADY_LINKED\`: that chat account already belongs to a Forge user, possibly another.
  There is no unlink door today; this needs a person who can reach the database, so say so.
- No address was handed (the person never wrote in the thread): ask them to write there first.
- Known gap: a person cannot start a link themself. The page address comes only from you (the
  \`link\` act) or from a refusal that names it. If you cannot give it, say that plainly and route it
  with \`support.route\` to forge; do not invent another way.`,
};
