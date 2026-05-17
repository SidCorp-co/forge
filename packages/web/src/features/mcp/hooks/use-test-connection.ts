'use client';

import { useMutation } from '@tanstack/react-query';
import { testConnection, type TestConnectionInput, type TestConnectionResult } from '../api';

export function useTestConnection() {
  return useMutation<TestConnectionResult, Error, TestConnectionInput>({
    mutationFn: testConnection,
  });
}
