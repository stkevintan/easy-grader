import { QueryClient } from '@tanstack/react-query';

const TOKEN_KEY = 'eg-console-token';

export const session = {
  token: (): string => sessionStorage.getItem(TOKEN_KEY) ?? '',
  set: (token: string) => sessionStorage.setItem(TOKEN_KEY, token),
  clear: () => sessionStorage.removeItem(TOKEN_KEY),
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = session.token();
  const res = await fetch(path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && token) {
    session.clear();
    if (!location.hash.startsWith('#/login')) location.hash = '#/login';
  }
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const message =
      data && typeof data === 'object' && 'message' in data
        ? Array.isArray(data.message)
          ? data.message.join('；')
          : String(data.message)
        : `请求失败（${res.status}）`;
    throw new ApiError(res.status, message);
  }
  return data as T;
}

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});
