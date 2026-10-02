import { NextFunction, Request, Response } from 'express';
import { Errors } from '../utils/AppError.js';
import type { AuthenticatedUser } from './authenticate.js';

export function requireRole(...roles: AuthenticatedUser['role'][]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(Errors.unauthorized());
    if (!roles.includes(req.user.role)) return next(Errors.forbidden());
    next();
  };
}
