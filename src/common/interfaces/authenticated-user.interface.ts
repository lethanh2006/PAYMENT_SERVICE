import type { Request } from 'express';

export interface AuthenticatedUser {
  _id?: string;
  id?: string;
  role?: string;
  username?: string;
  email?: string;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
  requestId?: string;
}

export function userIdOf(user: AuthenticatedUser | undefined): string | null {
  const value = user?._id ?? user?.id;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
