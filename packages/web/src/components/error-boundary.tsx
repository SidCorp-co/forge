'use client';

import { Component, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback ?? (
          <div className="flex min-h-[200px] items-center justify-center p-8">
            <div className="text-center">
              <h2 className="mb-2 text-lg font-semibold">Something went wrong</h2>
              <p className="mb-4 text-sm text-primary-fixed">{this.state.error?.message}</p>
              <Button onClick={() => this.setState({ hasError: false, error: null })}>
                Try again
              </Button>
            </div>
          </div>
        )
      );
    }

    return this.props.children;
  }
}
