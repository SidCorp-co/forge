// What each `/api/conversations/:id` route declares (REQ-12 BC-20, ISS-824). A room is reached by
// who is in it and the roles its derived scope grants, not by one permission on one project, so each
// route is declared by the rule in `conversations/access.ts` that decides it, checked in the handler
// as before. None has a floor: the room's not-found and the rule's own refusals answer first.

import { requiresByRule } from '../permissions/index.js';

const ACCESS = 'conversations/access.ts';

export const ROOM_READ = requiresByRule(
  `${ACCESS}:readableConversation`,
  'a reader of the room: a role reaching its derived scope, and a one-to-one room only its people',
);

export const ROOM_WRITE = requiresByRule(
  `${ACCESS}:writableConversation`,
  'a writer in the room: a writing role on its derived scope, and a one-to-one room only its people',
);

export const ROOM_MEMBERSHIP = requiresByRule(
  `${ACCESS}:withMembershipLock`,
  'a writer in the room who is already one of its people; a room recording none is changed where it lives',
);

export const ROOM_ADD_HANDLE = requiresByRule(
  'assistant/service.ts:addRoomHandle',
  'a writer in the room who is one of its people, and project.write on the project the body names, whose handle it must be (HANDLE_NOT_ON_PROJECT)',
);

export const PROPOSAL_AGREE = requiresByRule(
  'assistant/agreement/agreement-door.ts:agreementOf',
  'the person the proposal waits on, from their own sign-in (CHAT_AGREEMENT_DOOR, CHAT_PROPOSAL_NOT_YOURS), and a reader of the room',
);

export const PROPOSAL_PLAIN = requiresByRule(
  'assistant/agreement/plain-door.ts:plainWriterOf',
  'the Agent session whose request the proposal holds, on its own credential, while it waits (CHAT_PROPOSAL_NOT_YOURS, CHAT_PROPOSAL_SETTLED)',
);

export const PROPOSAL_DECLINE = requiresByRule(
  'assistant/agreement/agreement-door.ts:declinerOf',
  'the person the proposal waits on, from their own sign-in (CHAT_AGREEMENT_DOOR, CHAT_PROPOSAL_NOT_YOURS), and a reader of the room',
);
