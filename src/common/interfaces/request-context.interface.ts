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
  clientRequestId?: string;
}
