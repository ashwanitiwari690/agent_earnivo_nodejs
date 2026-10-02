import { NextFunction, Request, Response } from 'express';
import { verifyAccessToken } from '../utils/jwt.js';
import { Errors } from '../utils/AppError.js';
import { prisma } from '../db/prisma.js';

export interface AuthenticatedUser {
  id: string;
  role: 'USER' | 'AGENT' | 'ADMIN';
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

// Identity, plus the one thing that can't be left to each route: whether
// this account is still allowed to be signed in at all. Everything else an
// endpoint needs (agent record, subscription, permissions) is re-derived
// from the database inside its own service - the token's role claim is
// enough to route the request, never enough on its own to authorize a
// write.
//
// The status check is a DB lookup on every request specifically because an
// access token is a signed, stateless credential that - by design - keeps
// working right up to its own expiry (JWT_ACCESS_EXPIRES_IN, 30 days in this
// app) no matter what happens to the account afterwards. Without it, an
// admin suspending an agent (admin-agents.service.ts's setAgentStatus, or
// admin-users.service.ts's setUserStatus) would have zero effect on that
// agent's already-open session until their current token happened to expire
// on its own, days or weeks later - which is exactly the bug reported: an
// agent kept using the panel freely after being blocked. login()/refresh()
// already gate on User.status at the moment a *new* token is issued; this
// is what makes a suspension actually take effect on tokens issued before
// it, on the very next request.
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;

  if (!token) return next(Errors.unauthorized());

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    return next(Errors.unauthorized('Invalid or expired session.'));
  }

  const user = await prisma.user.findUnique({ where: { id: payload.sub }, select: { status: true } });
  if (!user) return next(Errors.unauthorized('Invalid or expired session.'));
  if (user.status !== 'ACTIVE') return next(Errors.userSuspended());

  req.user = { id: payload.sub, role: payload.role };
  next();
}
