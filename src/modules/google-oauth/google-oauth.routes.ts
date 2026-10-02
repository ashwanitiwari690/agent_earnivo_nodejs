import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { authenticate } from '../../middleware/authenticate.js';
import { requireRole } from '../../middleware/requireRole.js';
import {
  agentAuthorizeUrlHandler,
  agentConnectionHandler,
  callbackHandler,
  disconnectAgentHandler,
  disconnectUserHandler,
  refreshAgentChannelHandler,
  userAuthorizeUrlHandler,
  userConnectionHandler,
} from './google-oauth.controller.js';

// Each authorize-url call mints a signed state and each callback performs a
// real token exchange with Google, so both are worth a limiter of their own -
// generous next to what a person clicking "Connect" actually does, tight
// enough that nothing can be used to hammer Google's token endpoint through
// this server.
const connectLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' } },
});

export const googleOAuthRouter = Router();

// Unauthenticated by necessity: the browser landing here was redirected by
// Google and carries no Earnivo session. Identity comes from the signed
// `state`, which google-oauth.service.ts refuses unless it signed it itself.
// Mounted first so the authenticated sub-routers below never shadow it.
googleOAuthRouter.get('/callback', connectLimiter, callbackHandler);

const agentRouter = Router();
agentRouter.use(authenticate, requireRole('AGENT'));
agentRouter.get('/authorize-url', connectLimiter, agentAuthorizeUrlHandler);
agentRouter.get('/connection', agentConnectionHandler);
// Re-reads the channel from YouTube on the existing grant - for an agent who
// renamed their channel and wants Earnivo to catch up without reconnecting.
agentRouter.post('/connection/refresh-channel', connectLimiter, refreshAgentChannelHandler);
agentRouter.delete('/connection', disconnectAgentHandler);
googleOAuthRouter.use('/agent', agentRouter);

const userRouter = Router();
userRouter.use(authenticate, requireRole('USER'));
userRouter.get('/authorize-url', connectLimiter, userAuthorizeUrlHandler);
userRouter.get('/connection', userConnectionHandler);
userRouter.delete('/connection', disconnectUserHandler);
googleOAuthRouter.use('/user', userRouter);
