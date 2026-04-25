import Link from 'next/link';
import Image from 'next/image';
import type { Metadata } from 'next';
import logoImg from '../../public/180x180.png';

export const metadata: Metadata = {
  title: 'Not found · Forge',
};

export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-surface px-6 font-['Inter'] antialiased">
      <div className="w-full max-w-md text-center">
        <div className="mb-6 flex justify-center">
          <Image src={logoImg} alt="Forge" width={64} height={64} className="rounded-sm" />
        </div>
        <p className="text-[10px] font-bold uppercase tracking-[0.3em] text-on-surface-variant">
          Error 404
        </p>
        <h1 className="mt-3 text-2xl font-bold tracking-tight text-primary">
          Page not found
        </h1>
        <p className="mt-3 text-sm text-on-surface-variant">
          The page you&apos;re looking for doesn&apos;t exist or has been moved.
        </p>
        <div className="mt-8">
          <Link
            href="/projects"
            className="inline-flex items-center justify-center rounded-sm bg-primary px-8 py-3 text-[10px] font-bold uppercase tracking-[0.2em] text-on-primary shadow-lg transition-all hover:bg-tertiary active:scale-[0.98]"
          >
            Back to projects
          </Link>
        </div>
      </div>
    </div>
  );
}
