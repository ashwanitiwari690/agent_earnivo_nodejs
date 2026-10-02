import { NextFunction, Request, Response } from 'express';
import { ZodType } from 'zod';

declare global {
  namespace Express {
    interface Request {
      validatedQuery?: any;
    }
  }
}

export function validateBody(schema: ZodType) {
  return (req: Request, _res: Response, next: NextFunction) => {
    req.body = schema.parse(req.body);
    next();
  };
}

// express@5's Request['query'] is typed as ParsedQs (string-ish values
// only); a parsed zod query can legitimately contain numbers/booleans
// (page, pageSize, isActive), so it's stored separately rather than forced
// back into `query`'s stricter shape.
export function validateQuery(schema: ZodType) {
  return (req: Request, _res: Response, next: NextFunction) => {
    req.validatedQuery = schema.parse(req.query);
    next();
  };
}
