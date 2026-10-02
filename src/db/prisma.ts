import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client.js';
import { env } from '../config/env.js';

// The pool is built here rather than letting the adapter create its own from
// a bare connection string, for two reasons that both only show up under
// load:
//
//   1. Sizing. Every in-flight query holds one connection, so the pool size
//      is the actual ceiling on how many requests this process can serve
//      concurrently. The driver's default is small; past it, requests queue.
//   2. Crash safety. node-postgres emits 'error' on the Pool when an idle
//      connection dies (a database restart, a dropped network link, an idle
//      timeout on a managed Postgres). An EventEmitter 'error' with no
//      listener is rethrown as an uncaught exception, which takes the whole
//      server down - not because of anything a request did, but because the
//      database blinked. The listener below is what turns that into a log
//      line. The pool then replaces the dead connection by itself.
export const pool = new pg.Pool({
  connectionString: env.databaseUrl,
  max: env.dbPoolMax,
  min: env.dbPoolMin,
  idleTimeoutMillis: env.dbPoolIdleTimeoutMs,
  connectionTimeoutMillis: env.dbConnectionTimeoutMs,
  // Enforced by PostgreSQL itself, so it applies even if this process stops
  // paying attention: no single statement can pin a pooled connection for
  // longer than this and starve everyone waiting behind it.
  statement_timeout: env.dbStatementTimeoutMs,
  // The client-side twin of the above - covers the case where the server
  // answered but the connection is wedged somewhere in between.
  query_timeout: env.dbStatementTimeoutMs,
  // Keeps idle connections alive through NAT/firewall idle reaping, which
  // otherwise hands out a silently dead socket to the next request.
  keepAlive: true,
  // Shows up in pg_stat_activity, so a DBA looking at a busy database can
  // tell these connections apart from psql sessions and migrations.
  application_name: 'earnivo-api',
});

pool.on('error', (err) => {
  console.error('[db] idle client error (pool will recover on its own)', err);
});

const adapter = new PrismaPg(pool);

export const prisma = new PrismaClient({ adapter });

// Cheap liveness probe for /health/db: round-trips to PostgreSQL without
// touching any application table.
export async function checkDatabase(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (err) {
    console.error('[db] health check failed', err);
    return false;
  }
}

export function poolStats() {
  return { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount, max: env.dbPoolMax };
}

// Called from the shutdown path so a restart closes connections cleanly
// instead of leaving PostgreSQL to time them out.
export async function disconnectDatabase(): Promise<void> {
  try {
    await prisma.$disconnect();
  } catch (err) {
    console.error('[db] error disconnecting prisma', err);
  }
  try {
    await pool.end();
  } catch (err) {
    console.error('[db] error ending pool', err);
  }
}
