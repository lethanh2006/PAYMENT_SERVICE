import type { AuthenticatedUser } from '../interfaces/request-context.interface';

export function userIdOf(user: AuthenticatedUser | undefined): string | null {
  const value = user?._id ?? user?.id;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
