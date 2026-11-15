import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, session } from './client';
import type { User } from './types';

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => api<User>('GET', '/api/auth/me'),
    enabled: session.token() !== '',
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { username: string; password: string }) =>
      api<{ token: string; user: User }>('POST', '/api/auth/login', input),
    onSuccess: (r) => {
      session.set(r.token);
      qc.setQueryData(['me'], r.user);
    },
  });
}

export function useRegister() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { username: string; password: string; inviteToken: string }) =>
      api<{ token: string; user: User }>('POST', '/api/auth/register', input),
    onSuccess: (r) => {
      session.set(r.token);
      qc.setQueryData(['me'], r.user);
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return () => {
    session.clear();
    qc.clear();
    location.hash = '#/login';
  };
}
