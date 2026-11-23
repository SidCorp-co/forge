// Who decided a requirement revision, or agreed its baseline: a Forge user, or a speaker a project
// admin declared by chat identity for `accept`, who did it with no Forge account (REQ-90 BC-15,
// ISS-1436, migration 0693), by that identity's account (`chat_temporary_accounts`) and the name the
// room showed. The user column is null until the identity links an account, then written as theirs.

import { text, uuid } from 'drizzle-orm/pg-core';
import { users } from './schema-auth.js';
import { chatTemporaryAccounts } from './schema-support-asks.js';

const person = (name: string) => uuid(name).references(() => users.id, { onDelete: 'restrict' });
const chatAccount = (name: string) =>
  uuid(name).references(() => chatTemporaryAccounts.id, { onDelete: 'restrict' });

/** A revision's decider: `decided_by`, or the chat identity beside it. */
export const revisionDeciderColumns = () => ({
  decidedBy: person('decided_by'),
  decidedByChatAccount: chatAccount('decided_by_chat_account'),
  decidedByChatName: text('decided_by_chat_name'),
});

/** A baseline's agreer: `agreed_by`, or the chat identity beside it. */
export const baselineAgreerColumns = () => ({
  agreedBy: person('agreed_by'),
  agreedByChatAccount: chatAccount('agreed_by_chat_account'),
  agreedByChatName: text('agreed_by_chat_name'),
});
