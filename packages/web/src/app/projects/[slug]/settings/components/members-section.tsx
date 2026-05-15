'use client';

import { useState } from 'react';
import { useInviteProjectMember } from '@/features/project/hooks/use-projects';

interface Props {
  projectId: string;
  isOwner: boolean;
}

export function MembersSection({ projectId, isOwner }: Props) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const [feedback, setFeedback] = useState<string | null>(null);
  const invite = useInviteProjectMember();

  const onInvite = async () => {
    setFeedback(null);
    if (!email.trim() || !isOwner) return;
    try {
      await invite.mutateAsync({ projectId, email: email.trim(), role });
      setEmail('');
      setFeedback(`Invitation sent to ${email.trim()}.`);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Failed to send invitation.');
    }
  };

  return (
    <section className="space-y-6">
      <div className="flex justify-between items-end border-b border-outline-variant/10 pb-2">
        <div className="flex items-center gap-3">
          <h2 className="text-[10px] uppercase tracking-[0.2em] text-on-surface-variant font-bold">
            Members
          </h2>
          {!isOwner && (
            <span className="rounded-sm border border-outline-variant/30 px-2 py-0.5 text-[9px] font-mono uppercase tracking-widest text-outline">
              Owner only
            </span>
          )}
        </div>
        <span className="text-[9px] font-mono text-outline">IDN_MBR</span>
      </div>

      <div className="bg-surface-container-low border border-outline-variant/30 p-8 space-y-6">
        <div>
          <label
            htmlFor="invite-email"
            className="mb-1 block text-sm font-medium text-on-surface-variant"
          >
            Invite by email
          </label>
          <div className="flex gap-2">
            <input
              id="invite-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="teammate@example.com"
              disabled={!isOwner}
              className="flex-1 bg-transparent border-0 border-b border-outline/30 rounded-none py-3 text-sm text-on-surface placeholder:text-outline/40 focus:outline-none focus:border-b-primary focus:ring-0 transition-colors disabled:opacity-50"
            />
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as 'admin' | 'member')}
              disabled={!isOwner}
              className="bg-transparent border-0 border-b border-outline/30 rounded-none py-3 text-sm text-on-surface focus:outline-none focus:border-b-primary disabled:opacity-50"
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
            <button
              type="button"
              onClick={() => void onInvite()}
              disabled={!isOwner || invite.isPending || !email.trim()}
              className="bg-primary text-on-primary px-6 py-2 text-[10px] font-bold uppercase tracking-[0.15em] rounded-sm hover:opacity-90 disabled:opacity-50"
            >
              {invite.isPending ? 'Sending…' : 'Invite'}
            </button>
          </div>
          {feedback && <p className="mt-2 text-xs text-outline">{feedback}</p>}
        </div>

        <p className="text-[10px] text-outline">
          Member list with remove controls ships in v0.1.7 once the project detail endpoint
          returns full user rows. Invitations are sent immediately via email and accepted via
          token.
        </p>
      </div>
    </section>
  );
}
