import os from 'node:os';
import cluster from 'node:cluster';
import type { Server } from 'node:http';

const CPU_COUNT = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;

// libuv reads UV_THREADPOOL_SIZE once, when the thread pool is first used.
// That pool is what bcrypt hashing and file uploads run on, and it holds
// four threads by default - so five simultaneous logins already queue behind
// each other no matter how much CPU is free. It has to be set before any of
// that work is submitted, which is why every other import in this file is
// dynamic: static imports are evaluated before the module body runs, and one
// of them would otherwise touch the pool first.
if (!process.env.UV_THREADPOOL_SIZE) {
  process.env.UV_THREADPOOL_SIZE = String(Math.min(Math.max(CPU_COUNT * 2, 8), 32));
}

const { env } = await import('./config/env.js');

function resolveWorkerCount(): number {
  if (!Number.isFinite(env.clusterWorkers) || env.clusterWorkers < 0) return 1;
  if (env.clusterWorkers === 0) return CPU_COUNT;
  return Math.max(1, Math.floor(env.clusterWorkers));
}

// ---------------------------------------------------------------------------
// Primary process: owns no sockets of its own, it just keeps workers alive.
// ---------------------------------------------------------------------------
function runPrimary(workerCount: number) {
  console.log(
    `[cluster] primary ${process.pid} starting ${workerCount} worker(s) on ${CPU_COUNT} CPU(s), ` +
      `thread pool ${process.env.UV_THREADPOOL_SIZE}`,
  );

  let shuttingDown = false;
  // Exactly one worker runs the cron sweeps. Without this, every worker would
  // expire the same campaign and send the same person the same notification
  // once per worker.
  let schedulerWorkerId: number | undefined;
  const recentRestarts: number[] = [];

  const forkWorker = (isScheduler: boolean) => {
    const worker = cluster.fork({
      // Passed explicitly so the value is in place before the worker starts,
      // rather than relying on it being set early enough inside it.
      UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE,
      RUN_SCHEDULED_JOBS: isScheduler ? 'true' : 'false',
    });
    if (isScheduler) schedulerWorkerId = worker.id;
    return worker;
  };

  for (let i = 0; i < workerCount; i += 1) forkWorker(i === 0);

  cluster.on('exit', (worker, code, signal) => {
    if (shuttingDown) return;

    const wasScheduler = worker.id === schedulerWorkerId;
    console.error(
      `[cluster] worker ${worker.process.pid} exited (code ${code}, signal ${signal ?? 'none'}) - restarting`,
    );

    // A worker that dies instantly on startup - a bad DATABASE_URL, a port
    // conflict - would otherwise be reforked in a tight loop that pins a CPU
    // and floods the logs. Once restarts are clearly pathological, back off.
    const now = Date.now();
    recentRestarts.push(now);
    while (recentRestarts.length > 0 && now - recentRestarts[0]! > 60_000) recentRestarts.shift();
    const delayMs = recentRestarts.length > workerCount * 4 ? 5_000 : 0;

    setTimeout(() => {
      if (!shuttingDown) forkWorker(wasScheduler);
    }, delayMs).unref();
  });

  const stopAll = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[cluster] ${signal} received, stopping workers`);
    for (const worker of Object.values(cluster.workers ?? {})) worker?.kill(signal);
    // Unref'd so the primary exits as soon as the last worker is gone, and
    // waits out the full grace period only if one refuses to leave.
    setTimeout(() => process.exit(0), env.shutdownTimeoutMs).unref();
  };

  process.on('SIGTERM', () => stopAll('SIGTERM'));
  process.on('SIGINT', () => stopAll('SIGINT'));
}

// ---------------------------------------------------------------------------
// Worker, or the whole server when clustering is off.
// ---------------------------------------------------------------------------
async function runServer() {
  const { app } = await import('./app.js');
  const { disconnectDatabase } = await import('./db/prisma.js');
  const { initSocketServer } = await import('./realtime/socket.service.js');

  const server: Server = app.listen(env.port, () => {
    const role = cluster.isWorker ? `worker ${process.pid}` : `pid ${process.pid}`;
    console.log(`Earnivo API listening on http://localhost:${env.port} (${role})`);
  });

  // Attached to the same HTTP server Express just started listening on, so
  // it shares its port and needs no separate process or proxy rule.
  initSocketServer(server);

  // Must exceed the idle timeout of whatever proxy sits in front. If Node
  // closes a kept-alive socket first, the proxy can still send a request down
  // it and the caller gets an unexplained 502.
  server.keepAliveTimeout = env.httpKeepAliveTimeoutMs;
  // Node requires headersTimeout to be the larger of the two.
  server.headersTimeout = env.httpHeadersTimeoutMs;
  // A hard ceiling per request, so a client that opens a connection and then
  // stalls mid-body eventually releases it instead of occupying a socket, and
  // anything that socket is holding, indefinitely.
  server.requestTimeout = env.httpRequestTimeoutMs;

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[server] port ${env.port} is already in use`);
      process.exit(1);
    }
    console.error('[server] listen error', err);
  });

  // True in exactly one process: the scheduler worker under clustering, or
  // the single process when clustering is off.
  const runJobs = !cluster.isWorker || process.env.RUN_SCHEDULED_JOBS === 'true';
  if (runJobs) {
    const [{ startExpireCampaignsJob }, { startExpireSubscriptionsJob }, { startCleanupCancelledCampaignFilesJob }] =
      await Promise.all([
        import('./jobs/expireCampaigns.job.js'),
        import('./jobs/expireSubscriptions.job.js'),
        import('./jobs/cleanupCancelledCampaignFiles.job.js'),
      ]);
    startExpireCampaignsJob();
    startExpireSubscriptionsJob();
    startCleanupCancelledCampaignFilesJob();
    console.log(`[jobs] scheduled sweeps running in pid ${process.pid}`);
  }

  let shuttingDown = false;

  const shutdown = (reason: string, exitCode: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] shutting down (${reason})`);

    // Unref'd timer that fires only if something is genuinely stuck. Without
    // it a single hung request keeps a dying process alive indefinitely.
    const force = setTimeout(() => {
      console.error('[server] graceful shutdown timed out, exiting now');
      process.exit(exitCode || 1);
    }, env.shutdownTimeoutMs);
    force.unref();

    server.close(() => {
      void disconnectDatabase().finally(() => process.exit(exitCode));
    });
    // Idle kept-alive sockets would otherwise hold the close open for the
    // entire grace period even though no request is in flight.
    server.closeIdleConnections?.();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM', 0));
  process.on('SIGINT', () => shutdown('SIGINT', 0));

  // Node terminates the process on an unhandled rejection by default. One
  // forgotten .catch() on a background write - a fire-and-forget view
  // counter, a notification - would therefore kill a server that is
  // otherwise healthy and answering every other request correctly. Logging
  // and continuing is the right trade: the failure is already contained to
  // the one request that caused it.
  process.on('unhandledRejection', (reason) => {
    console.error('[fatal] unhandled promise rejection (server kept running)', reason);
  });

  // An uncaught exception is a different case: the process may be in an
  // indeterminate state, so continuing carries real risk. Under clustering
  // the safe move is available - exit, let the primary fork a clean
  // replacement, and let the remaining workers carry traffic meanwhile, so
  // nobody sees an outage. Without clustering there is nothing to fail over
  // to and exiting would mean total downtime, so it stays up and logs loudly.
  process.on('uncaughtException', (err, origin) => {
    console.error(`[fatal] uncaught exception (${origin})`, err);
    if (cluster.isWorker) shutdown('uncaughtException', 1);
  });
}

const workerCount = resolveWorkerCount();

if (workerCount > 1 && cluster.isPrimary) {
  runPrimary(workerCount);
} else {
  await runServer();
}
