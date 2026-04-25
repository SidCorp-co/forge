'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/providers/auth-provider';
import { useSetPageTitle } from '@/hooks/use-page-title';

export default function LoginPage() {
  useSetPageTitle('Login');
  const { login } = useAuth();
  const router = useRouter();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login({ email: identifier, password });
      router.push('/projects');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="w-full max-w-[420px] z-10">
      {/* Brand Identity */}
      <div className="flex flex-col items-center mb-12 space-y-4">
        <div className="w-12 h-12 border-2 border-primary flex items-center justify-center">
          <svg className="w-7 h-7 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M11.42 15.17l-5.384-3.19A2.625 2.625 0 015 9.817V6.456a2.625 2.625 0 013.036-2.592l5.384 1.538a2.625 2.625 0 011.58 1.259l2.72 5.038a2.625 2.625 0 01-.384 3.006l-3.378 3.565a2.625 2.625 0 01-3.538-.1z" />
          </svg>
        </div>
        <h1 className="font-extrabold text-2xl tracking-tighter uppercase text-primary">
          Forge
        </h1>
      </div>

      {/* Login Container */}
      <div className="bg-surface-container-low p-10 border border-outline-variant/20 shadow-2xl">
        <header className="mb-10">
          <h2 className="text-xl font-semibold text-primary tracking-tight">
            System access
          </h2>
          <p className="text-on-surface-variant text-xs uppercase tracking-[0.2em] mt-2 font-medium">
            Authentication Required
          </p>
        </header>

        <form onSubmit={handleSubmit} className="space-y-8">
          {error && (
            <div className="border border-error-container bg-error-container/10 px-4 py-3">
              <p className="text-xs text-error">{error}</p>
            </div>
          )}

          {/* Inputs */}
          <div className="space-y-6">
            <div className="group">
              <label
                htmlFor="identifier"
                className="block text-[10px] uppercase tracking-widest text-on-surface-variant mb-1 group-focus-within:text-on-surface transition-colors"
              >
                Endpoint ID (Email)
              </label>
              <input
                id="identifier"
                type="text"
                required
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder="name@domain.com"
                className="w-full bg-transparent border-0 border-b border-outline/30 rounded-none py-3 text-sm text-on-surface placeholder:text-outline/40 focus:outline-none focus:border-b-primary focus:ring-0 transition-colors"
              />
            </div>

            <div className="group">
              <div className="flex justify-between items-center mb-1">
                <label
                  htmlFor="password"
                  className="text-[10px] uppercase tracking-widest text-on-surface-variant group-focus-within:text-on-surface transition-colors"
                >
                  Access Key (Password)
                </label>
                <span className="text-[9px] uppercase tracking-widest text-outline hover:text-on-surface transition-colors cursor-pointer">
                  Recovery
                </span>
              </div>
              <input
                id="password"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full bg-transparent border-0 border-b border-outline/30 rounded-none py-3 text-sm text-on-surface placeholder:text-outline/40 focus:outline-none focus:border-b-primary focus:ring-0 transition-colors"
              />
            </div>
          </div>

          {/* Primary Action */}
          <button
            type="submit"
            disabled={loading}
            className="w-full py-4 text-[11px] font-bold uppercase tracking-[0.25em] text-on-primary active:scale-[0.98] transition-all duration-150 disabled:opacity-50"
            style={{ background: 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-tertiary) 100%)' }}
          >
            {loading ? 'Initializing...' : 'Initialize Session'}
          </button>

          {/* Divider */}
          <div className="relative flex py-4 items-center">
            <div className="flex-grow border-t border-outline-variant/20" />
            <span className="flex-shrink mx-4 text-[9px] uppercase tracking-widest text-outline/50">
              External Protocols
            </span>
            <div className="flex-grow border-t border-outline-variant/20" />
          </div>

          {/* Social Logins */}
          <div className="grid grid-cols-2 gap-4">
            <button
              type="button"
              className="flex items-center justify-center space-x-3 py-3 border border-outline-variant/30 hover:bg-surface-container-high transition-colors active:scale-95"
            >
              <svg className="w-4 h-4 text-on-surface-variant" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"/>
              </svg>
              <span className="text-[10px] uppercase tracking-widest font-semibold text-on-surface">
                GitHub
              </span>
            </button>
            <button
              type="button"
              className="flex items-center justify-center space-x-3 py-3 border border-outline-variant/30 hover:bg-surface-container-high transition-colors active:scale-95"
            >
              <svg className="w-4 h-4 text-on-surface-variant" viewBox="0 0 24 24" fill="currentColor">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.56c2.08-1.92 3.28-4.74 3.28-8.1z"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.56-2.77c-.98.66-2.23 1.06-3.72 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
              </svg>
              <span className="text-[10px] uppercase tracking-widest font-semibold text-on-surface">
                Google
              </span>
            </button>
          </div>
        </form>
      </div>

      {/* Footer Metadata */}
      <footer className="mt-8 flex justify-between items-center px-2">
        <span className="text-[9px] text-outline/50 uppercase tracking-[0.3em]">
          Build v2.4.0-Stable
        </span>
        <div className="flex space-x-4">
          <span className="text-[9px] text-outline/50 hover:text-on-surface transition-colors uppercase tracking-[0.2em] cursor-pointer">
            Privacy
          </span>
          <Link
            href="/register"
            className="text-[9px] text-outline/50 hover:text-on-surface transition-colors uppercase tracking-[0.2em]"
          >
            Register
          </Link>
        </div>
      </footer>

      {/* Status Terminal Module */}
      <div className="fixed bottom-8 right-8 hidden lg:block">
        <div className="bg-background border border-outline-variant/40 p-4 w-64">
          <div className="flex items-center space-x-2 mb-3">
            <div className="w-1.5 h-1.5 bg-primary" />
            <span className="text-[10px] uppercase tracking-widest font-bold text-primary">
              System Log
            </span>
          </div>
          <div className="space-y-1.5">
            <div className="flex justify-between text-[9px] font-mono text-outline/60">
              <span>&gt; CORE_INIT</span>
              <span className="text-on-surface/40">OK</span>
            </div>
            <div className="flex justify-between text-[9px] font-mono text-outline/60">
              <span>&gt; SSL_HANDSHAKE</span>
              <span className="text-on-surface/40">DONE</span>
            </div>
            <div className="flex justify-between text-[9px] font-mono text-outline/60">
              <span>&gt; AUTH_WAIT</span>
              <span className="animate-pulse">_</span>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
