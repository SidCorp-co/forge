'use client';

import { useState } from 'react';
import { useInviteProjectMember, useProject } from '@/features/project/hooks/use-projects';

interface Props {
  projectId: string;
}

export function MembersStep({ projectId }: Props) {
  const { data: project } = useProject(projectId);
  const invite = useInviteProjectMember();

  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const onInvite = async () => {
    if (!email.includes('@')) {
      setError('Enter a valid email address.');
      return;
    }
    setError(null);
    setSuccess(null);
    try {
      await invite.mutateAsync({ projectId, email, role });
      setSuccess(`Invite sent to ${email}.`);
      setEmail('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to send invite.');
    }
  };

  const memberCount = project?.members.length ?? 0;

  return (
    <div className="space-y-4">
      <p className="text-sm text-on-surface-variant">
        Optional — invite teammates by email. You can also do this later from
        project settings.
      </p>

      <div className="grid grid-cols-[1fr_auto_auto] gap-2 items-end">
        <div>
          <label htmlFor="invite-email" className="block text-xs text-outline mb-1">
            Email
          </label>
          <input
            id="invite-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="teammate@example.com"
            className="w-full bg-transparent border-0 border-b border-outline/30 py-2 text-sm focus:outline-none focus:border-b-primary"
          />
        </div>
        <div>
          <label htmlFor="invite-role" className="block text-xs text-outline mb-1">
            Role
          </label>
          <select
            id="invite-role"
            value={role}
            onChange={(e) => setRole(e.target.value as 'member' | 'admin')}
            className="bg-transparent border border-outline/30 py-2 px-2 text-sm rounded-sm"
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        <button
          type="button"
          onClick={() => void onInvite()}
          disabled={invite.isPending || !email}
          className="bg-primary text-on-primary px-4 py-2 text-sm rounded-sm disabled:opacity-50"
        >
          {invite.isPending ? 'Sending…' : 'Send invite'}
        </button>
      </div>

      {error && (
        <p className="text-xs text-error" role="alert">
          {error}
        </p>
      )}
      {success && <p className="text-xs text-success">{success}</p>}

      <div className="text-[11px] text-outline">
        Current members: <span className="font-mono">{memberCount}</span>
      </div>
    </div>
  );
}
