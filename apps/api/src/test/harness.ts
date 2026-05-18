export const CSRF_HEADERS = { 'x-primer-csrf': '1' } as const;

import type { createApp } from '../app.ts';

export type App = ReturnType<typeof createApp>;

/** Headers that simulate user `userId` plus the CSRF token. */
export function asUser(userId: string): Record<string, string> {
  return { 'x-mock-user-id': userId, 'x-primer-csrf': '1' };
}

export function asUserJson(userId: string): Record<string, string> {
  return { ...asUser(userId), 'content-type': 'application/json' };
}
