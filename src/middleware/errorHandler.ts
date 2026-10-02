import { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { MulterError } from 'multer';
import { Prisma } from '../../generated/prisma/client.js';
import { AppError } from '../utils/AppError.js';

// Postgres/driver-level failures that mean "the database is momentarily
// unreachable or saturated", not "this request was wrong". They deserve a
// 503 and a Retry-After rather than a 500, because retrying actually works.
const TRANSIENT_DB_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENOTFOUND',
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
  '08006', // connection_failure
  '08003', // connection_does_not_exist
]);

function isTransientDbError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && TRANSIENT_DB_CODES.has(code)) return true;
  const message = (err as { message?: unknown }).message;
  // node-postgres surfaces pool starvation as a plain Error with this text,
  // and Prisma's own pool timeout is P2024, handled separately below.
  return typeof message === 'string' && /timeout exceeded when trying to connect/i.test(message);
}

export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction) {
  // Once any bytes are on the wire a second response is impossible, and
  // calling res.status()/res.json() here throws ERR_HTTP_HEADERS_SENT from
  // inside the error handler itself - an exception with nowhere left to go,
  // which is one of the ways a Node process dies outright. Handing it back
  // to Express lets it close the connection properly instead.
  if (res.headersSent) return next(err);

  if (err instanceof AppError) {
    return res.status(err.status).json({ success: false, error: { code: err.code, message: err.message } });
  }

  if (err instanceof ZodError) {
    const message = err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return res.status(422).json({ success: false, error: { code: 'VALIDATION_ERROR', message } });
  }

  // Upload failures were reaching the generic 500 branch, so a user who
  // picked a 12MB photo got "Something went wrong" instead of being told the
  // file was too big. The size ceiling itself is route-dependent (see
  // upload.ts's CAMPAIGN_MAX_FILE_SIZE_BYTES) - campaign creatives (the one
  // upload that also accepts a video, for Video Promotion) get 10MB, every
  // other upload stays at 5MB, so the message is picked from the route
  // rather than a single hardcoded number that would be wrong for one of them.
  if (err instanceof MulterError) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    const isCampaignCreative = /\/campaigns\/[^/]+\/image$/.test(req.path);
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? `That file is too large. Please upload a file under ${isCampaignCreative ? '10MB' : '5MB'}.`
        : `Upload rejected: ${err.message}`;
    return res.status(status).json({ success: false, error: { code: err.code, message } });
  }

  // A malformed JSON body is a client mistake, not a server fault. Without
  // this it logs a stack trace and answers 500 on every hand-written curl
  // with a trailing comma.
  if (err instanceof SyntaxError && 'body' in err) {
    return res
      .status(400)
      .json({ success: false, error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON.' } });
  }

  if (typeof err === 'object' && err !== null && (err as { type?: string }).type === 'entity.too.large') {
    return res
      .status(413)
      .json({ success: false, error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large.' } });
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    switch (err.code) {
      case 'P2002': {
        const target = (err.meta?.target as string[] | string | undefined) ?? 'field';
        const fields = Array.isArray(target) ? target.join(', ') : String(target);
        return res.status(409).json({
          success: false,
          error: { code: 'DUPLICATE', message: `A record with this ${fields} already exists.` },
        });
      }
      case 'P2025':
        return res
          .status(404)
          .json({ success: false, error: { code: 'NOT_FOUND', message: 'The requested record no longer exists.' } });
      case 'P2003':
        return res.status(409).json({
          success: false,
          error: { code: 'FOREIGN_KEY_CONFLICT', message: 'That operation conflicts with a related record.' },
        });
      // Every pooled connection is busy. Under a burst this is the single
      // most likely failure, and it is the textbook case for "try again in
      // a moment" rather than a 500 the client gives up on.
      case 'P2024':
        res.setHeader('Retry-After', '2');
        return res.status(503).json({
          success: false,
          error: { code: 'SERVICE_BUSY', message: 'The server is busy right now. Please try again in a moment.' },
        });
      default:
        break;
    }
  }

  if (isTransientDbError(err)) {
    console.error('[errorHandler] transient database failure', err);
    res.setHeader('Retry-After', '2');
    return res.status(503).json({
      success: false,
      error: { code: 'SERVICE_UNAVAILABLE', message: 'The service is temporarily unavailable. Please try again.' },
    });
  }

  console.error(err);
  return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.' } });
}

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` } });
}
