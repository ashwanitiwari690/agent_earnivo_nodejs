import type { Server as HttpServer } from 'node:http';
import { Server as SocketIOServer, type Socket } from 'socket.io';
import { verifyAccessToken } from '../utils/jwt.js';
import { prisma } from '../db/prisma.js';
import type { AuthenticatedUser } from '../middleware/authenticate.js';

// One event, shared by every emit call below. `id` is present only when the
// row belongs to exactly one recipient (createNotification) - a client can
// splice that straight into its own list. When it's absent (a role-wide
// fan-out from notifyAdmins/broadcastAnnouncement, where each recipient got
// their own row with a different id from one createMany) the client just
// re-fetches its own list instead of guessing which id is theirs.
export interface RealtimeNotificationEvent {
  id?: string;
  userId?: string;
  type: string;
  title: string;
  message: string;
  metadata?: Record<string, unknown>;
  isRead?: boolean;
  createdAt: string;
}
const NOTIFICATION_EVENT = 'notification:new';

// Pushed the moment reward.service.ts's creditReward() actually finishes
// crediting a completion - the one thing the Ionic app's campaign-detail
// page used to find out about only by polling GET /task-completions/:id
// every few seconds while waiting on an external verification callback
// (App Promotion, Website Promotion token). Also pushed by
// admin-participations.service.ts's rejectParticipation(), so a proof-review
// task sitting in PENDING on an open campaign-detail page hears about a
// rejection the same way it already hears about an approval (approval goes
// through creditReward() below, same as every other crediting path).
export interface TaskCompletionUpdateEvent {
  completionId: string;
  taskId: string;
  campaignId: string;
  status: 'COMPLETED' | 'REJECTED';
  rewardAmount?: string;
  newBalance?: string;
  rejectionReason?: string;
}
const TASK_COMPLETION_EVENT = 'task-completion:updated';

let io: SocketIOServer | undefined;

// Real-time delivery for both the Agent/Admin panel (angular-agent-admin)
// and the Ionic app. The Ionic app still gets FCM push for everything push
// already covers (see services/push.service.ts) - that's unchanged and
// stays the channel for a backgrounded/closed app. This socket is instead
// for a screen that's open right now and would otherwise have to poll to
// find out something changed.
//
// Kept as its own module rather than folded into notifications.service.ts
// so server wiring (auth, rooms, CORS) stays separate from what gets
// broadcast and when.
//
// Note for the future: this uses Socket.IO's default in-memory adapter, so
// a broadcast only reaches sockets connected to the same process. That's a
// non-issue at today's default (CLUSTER_WORKERS=1 - see config/env.ts), but
// if this is ever run with more than one worker, sockets on worker B will
// stop receiving events emitted from a request handled by worker A. Fixing
// that needs a shared adapter (e.g. @socket.io/redis-adapter), which this
// codebase has no Redis instance for yet.
export function initSocketServer(httpServer: HttpServer): SocketIOServer {
  io = new SocketIOServer(httpServer, {
    // Mirrors app.ts's CORS policy exactly (see env.corsOrigins there) -
    // open to every origin by design, not narrowed here either.
    cors: { origin: true, credentials: true },
  });

  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.['token'] as string | undefined;
    if (!token) return next(new Error('Unauthorized'));

    let payload;
    try {
      payload = verifyAccessToken(token);
    } catch {
      return next(new Error('Unauthorized'));
    }

    // Same status re-check as the HTTP authenticate() middleware, and for
    // the same reason: a signed access token stays valid up to its own
    // expiry regardless of what happens to the account afterwards, so a
    // suspended account's already-open socket must not keep receiving
    // events.
    const user = await prisma.user.findUnique({ where: { id: payload.sub }, select: { status: true } });
    if (!user || user.status !== 'ACTIVE') return next(new Error('Unauthorized'));

    (socket.data as { user: AuthenticatedUser }).user = { id: payload.sub, role: payload.role };
    next();
  });

  io.on('connection', (socket: Socket) => {
    const user = (socket.data as { user: AuthenticatedUser }).user;
    // Two rooms per connection: one to reach this exact person
    // (createNotification, creditReward), one to reach everyone with their
    // role at once (notifyAdmins, broadcastAnnouncement) without looking up
    // who's online. Nothing ever emits to role:USER - it exists for
    // symmetry, not because anything targets it today.
    socket.join(`user:${user.id}`);
    socket.join(`role:${user.role}`);
  });

  return io;
}

function emit(room: string, event: string, payload: unknown): void {
  // No-ops before the server has started listening, and swallows any
  // delivery error - every call site below is piggybacking on a write it
  // must not fail just because a socket emit had a problem.
  if (!io) return;
  try {
    io.to(room).emit(event, payload);
  } catch (err) {
    console.error('[socket.service] emit failed', { room, event, reason: err instanceof Error ? err.message : String(err) });
  }
}

export function emitNotificationToUser(userId: string, payload: RealtimeNotificationEvent): void {
  emit(`user:${userId}`, NOTIFICATION_EVENT, payload);
}

export function emitNotificationToRole(role: 'AGENT' | 'ADMIN', payload: RealtimeNotificationEvent): void {
  emit(`role:${role}`, NOTIFICATION_EVENT, payload);
}

export function emitTaskCompletionUpdate(userId: string, payload: TaskCompletionUpdateEvent): void {
  emit(`user:${userId}`, TASK_COMPLETION_EVENT, payload);
}
