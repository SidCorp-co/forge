'use client';

import { useParams } from 'next/navigation';
import { WizardShell } from '@/features/project-setup/components/WizardShell';

export default function ProjectSetupPage() {
  const { slug } = useParams<{ slug: string }>();
  if (!slug) return null;
  return <WizardShell slug={slug} />;
}
