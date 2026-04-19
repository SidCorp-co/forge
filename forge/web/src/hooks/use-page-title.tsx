'use client';

import { createContext, useContext, useState, useLayoutEffect, type ReactNode } from 'react';

interface PageHeaderContextValue {
  title: string;
  setTitle: (title: string) => void;
  action: ReactNode;
  setAction: (action: ReactNode) => void;
}

const PageHeaderContext = createContext<PageHeaderContextValue>({
  title: '',
  setTitle: () => {},
  action: null,
  setAction: () => {},
});

export function PageTitleProvider({ children }: { children: ReactNode }) {
  const [title, setTitle] = useState('');
  const [action, setAction] = useState<ReactNode>(null);
  return (
    <PageHeaderContext.Provider value={{ title, setTitle, action, setAction }}>
      {children}
    </PageHeaderContext.Provider>
  );
}

export function usePageTitle(): string {
  return useContext(PageHeaderContext).title;
}

export function usePageHeaderAction(): ReactNode {
  return useContext(PageHeaderContext).action;
}

export function useSetPageTitle(title: string) {
  const { setTitle } = useContext(PageHeaderContext);
  useLayoutEffect(() => {
    setTitle(title);
    document.title = title ? `${title} · Forge` : 'Forge';
    return () => {
      setTitle('');
      document.title = 'Forge';
    };
  }, [title, setTitle]);
}

export function useSetPageHeaderAction(action: ReactNode) {
  const { setAction } = useContext(PageHeaderContext);
  useLayoutEffect(() => {
    setAction(action);
    return () => setAction(null);
  }, [action, setAction]);
}
