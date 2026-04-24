'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/providers/auth-provider';
import { useSetPageTitle } from '@/hooks/use-page-title';

export default function RegisterPage() {
  useSetPageTitle('Register');
  const { register } = useAuth();
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      // username is ignored in core registration (email + password only).
      void username;
      await register({ email, password });
      router.push('/login');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-full max-w-sm space-y-6">
      <div className="text-center">
        <h1 className="text-xl font-bold sm:text-2xl">Create an account</h1>
      </div>
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && <p className="text-sm text-danger">{error}</p>}
        <div>
          <label htmlFor="username" className="block text-sm font-medium text-on-surface-variant">
            Username
          </label>
          <input
            id="username"
            type="text"
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="mt-1 block w-full rounded border border-outline-variant px-3 py-2.5 text-sm focus:border-primary focus:outline-none"
          />
        </div>
        <div>
          <label htmlFor="email" className="block text-sm font-medium text-on-surface-variant">
            Email
          </label>
          <input
            id="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 block w-full rounded border border-outline-variant px-3 py-2.5 text-sm focus:border-primary focus:outline-none"
          />
        </div>
        <div>
          <label htmlFor="password" className="block text-sm font-medium text-on-surface-variant">
            Password
          </label>
          <input
            id="password"
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 block w-full rounded border border-outline-variant px-3 py-2.5 text-sm focus:border-primary focus:outline-none"
          />
        </div>
        <button
          type="submit"
          disabled={loading}
          className="w-full rounded bg-on-primary py-2.5 text-sm font-medium text-white hover:bg-surface-container disabled:opacity-50"
        >
          {loading ? 'Creating account...' : 'Create account'}
        </button>
      </form>
      <p className="text-center text-sm text-primary-fixed">
        Already have an account?{' '}
        <Link href="/login" className="text-on-primary underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
