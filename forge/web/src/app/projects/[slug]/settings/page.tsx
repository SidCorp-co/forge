'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import {
  useInviteProjectMember,
  useProjectBySlug,
} from '@/features/project/hooks/use-projects';
import { useSetPageTitle } from '@/hooks/use-page-title';
import { useAuth } from '@/providers/auth-provider';
import { DevicesSection } from './components/devices-section';
import { LabelsSection } from './components/labels-section';
import { SettingsView } from './components/settings-view';
import { useSettingsForm } from './hooks';

export default function ProjectSettingsPage() {
  useSetPageTitle('Project settings');
  const { user } = useAuth();
  const { slug } = useParams<{ slug: string }>();
  const project = useProjectBySlug(slug);
  const form = useSettingsForm(project?.id);

  if (!project) {
    return (
      <div className="flex flex-col gap-6 p-6">
        <p className="text-sm text-primary-fixed">Loading project…</p>
      </div>
    );
  }

  const isOwner = project.ownerId === user?.id;

  return (
    <div className="flex flex-col gap-8 p-6">
      <div>
        <h1 className="text-xl font-semibold text-on-surface">
          {form.state.name || project.name}
        </h1>
        <p className="mt-1 text-xs text-outline">
          Identity, chat agent, and provider configuration. More tabs unlock in v0.1.7+.
        </p>
      </div>

      <SettingsView
        {...form}
        projectSlug={project.slug}
        generalExtra={
          <>
            <MembersSection projectId={project.id} isOwner={isOwner} />
            <DevicesSection projectId={project.id} isOwner={isOwner} />
            <LabelsSection projectId={project.id} />
          </>
        }
      />
    </div>
  );
}

function MembersSection({ projectId, isOwner }: { projectId: string; isOwner: boolean }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const [feedback, setFeedback] = useState<string | null>(null);
  const invite = useInviteProjectMember();

  if (!isOwner) return null;

  const onInvite = async () => {
    setFeedback(null);
    if (!email.trim()) return;
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
        <h2 className="text-[10px] uppercase tracking-[0.2em] text-on-surface-variant font-bold">
          Members
        </h2>
        <span className="text-[9px] font-mono text-outline">MBR_CFG</span>
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
              className="flex-1 bg-transparent border-0 border-b border-outline/30 rounded-none py-3 text-sm text-on-surface placeholder:text-outline/40 focus:outline-none focus:border-b-primary focus:ring-0 transition-colors"
            />
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as 'admin' | 'member')}
              className="bg-transparent border-0 border-b border-outline/30 rounded-none py-3 text-sm text-on-surface focus:outline-none focus:border-b-primary"
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
            <button
              type="button"
              onClick={() => void onInvite()}
              disabled={invite.isPending || !email.trim()}
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
