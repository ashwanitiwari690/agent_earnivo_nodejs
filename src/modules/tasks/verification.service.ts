import type { TaskModel as Task } from '../../../generated/prisma/models.js';

export interface VerificationResult {
  status: 'PASSED' | 'FAILED' | 'PENDING';
  reason?: string;
}

export interface VerificationContext {
  // Set only once a proof image has been uploaded via the dedicated
  // task-completions/:id/proof endpoint - MANUAL is the one strategy that
  // reads this instead of the free-form submissionData JSON, since a
  // screenshot upload is a distinct step from the submit call itself.
  proofImageUrl: string | null;
  // TIME_ON_SITE only (Website Promotion) - the moment /tasks/:id/start
  // created this completion, and the agent-configured minimum seconds
  // (Task.configuration.visitDurationSeconds) that must have elapsed since
  // then before a submit is allowed to pass.
  startedAt: Date;
  requiredDwellSeconds?: number;
}

// Extensible verification architecture (spec Phase 5 §27): a task names a
// strategy in its configuration, and the dispatch below runs it. Adding a
// real integration later (YouTube API, app-install postback, a survey
// provider webhook, ...) means adding one function to STRATEGIES, not
// touching the completion state machine that calls verifyTaskCompletion.
// Phase 5 implements the architecture and each strategy's basic-level
// check; it does not integrate any external platform API yet.
// USER_CONFIRMATION is Phase 6's MVP default (spec §6/§23): the user starts
// the task, does it externally, comes back, and clicks "Complete Task" -
// the backend takes that confirmation at face value for every campaign
// type, with no per-type proof requirement. MANUAL is kept distinct for a
// possible future admin-review queue; the two behave identically today.
export type VerificationStrategyName =
  | 'USER_CONFIRMATION'
  | 'MANUAL'
  | 'URL'
  | 'SURVEY'
  | 'APP_DOWNLOAD'
  | 'VIDEO'
  | 'API'
  | 'SOCIAL_MEDIA'
  | 'CUSTOM'
  | 'TIME_ON_SITE'
  | 'WEBSITE_TOKEN'
  | 'YOUTUBE_SUBSCRIPTION';

type StrategyFn = (submissionData: Record<string, unknown>, context: VerificationContext) => VerificationResult;

const PASS: VerificationResult = { status: 'PASSED' };

// Fallback only - the normal path is an agent-configured value read from the
// task's own configuration (visitDurationSeconds), not this constant.
const DEFAULT_DWELL_SECONDS = 60;

const STRATEGIES: Record<VerificationStrategyName, StrategyFn> = {
  USER_CONFIRMATION: () => PASS,

  // The admin-review queue this comment used to describe as "possible
  // future" work: a genuine submission alone is no longer sufficient here -
  // a real proof image must have been uploaded first (via the dedicated
  // proof endpoint), and even then the task only moves to PENDING, not
  // PASSED. Crediting happens only once an Admin approves it.
  MANUAL: (_data, ctx) =>
    ctx.proofImageUrl ? { status: 'PENDING' } : { status: 'FAILED', reason: 'Please upload proof of completion before submitting this task.' },

  URL: (data) => (data['url'] ? PASS : { status: 'FAILED', reason: 'A URL submission is required for this task.' }),

  // SURVEY/APP_DOWNLOAD/VIDEO/SOCIAL_MEDIA/API all require *some* proof of
  // completion today (basic level) until each gets its real integration;
  // sharing one check now keeps that upgrade a one-line change per
  // strategy later instead of a rewrite.
  SURVEY: (data) => (data['proof'] ? PASS : { status: 'FAILED', reason: 'Survey completion proof is required for this task.' }),
  APP_DOWNLOAD: (data) => (data['proof'] ? PASS : { status: 'FAILED', reason: 'Proof of app installation is required for this task.' }),
  VIDEO: (data) => (data['proof'] ? PASS : { status: 'FAILED', reason: 'Proof of video completion is required for this task.' }),
  SOCIAL_MEDIA: (data) => (data['proof'] ? PASS : { status: 'FAILED', reason: 'Proof of the social action is required for this task.' }),
  API: (data) => (data['proof'] ? PASS : { status: 'FAILED', reason: 'Verification data is required for this task.' }),

  CUSTOM: () => PASS,

  // Dwell-time check shared by Website Promotion (agent-configured duration,
  // stays on the destination site) and Banner/Image Promotion (fixed 30s,
  // either on the destination site or viewing the banner image in-app - see
  // campaign-tasks.service.ts). The wording stays generic ("this task")
  // rather than naming a website, since it covers both. No client-supplied
  // data is trusted here at all - only the server-recorded startedAt
  // timestamp, so a client that calls submit early (bug, clock skew, or a
  // bypassed/malicious client hitting the API directly) is rejected
  // regardless of what it claims. Retryable (see eligibility.service.ts) -
  // waiting longer and resubmitting just re-checks the same startedAt.
  TIME_ON_SITE: (_data, ctx) => {
    const requiredSeconds = ctx.requiredDwellSeconds ?? DEFAULT_DWELL_SECONDS;
    const elapsedMs = Date.now() - ctx.startedAt.getTime();
    return elapsedMs >= requiredSeconds * 1000
      ? PASS
      : { status: 'FAILED', reason: `Please wait at least ${requiredSeconds} seconds before completing this task.` };
  },

  // Website Promotion with on-site verification enabled. Unreachable through
  // the normal submit path - submitTask refuses a WEBSITE_TOKEN submission
  // outright (before touching the completion's state), because the only
  // thing that may credit one of these is the promoted website's own
  // callback: POST /website-verification/confirm, carrying the one-time
  // token the Ionic app appended to the destination URL at /start time.
  // Kept here so the strategy is a first-class member of this map rather
  // than a special case the dispatch has to know about, and so a future
  // caller that does reach it fails closed instead of crediting.
  WEBSITE_TOKEN: () => ({
    status: 'FAILED',
    reason: "This task is verified on the advertiser's website. Open the site and use the reward button there.",
  }),

  // YouTube Subscribe with real OAuth verification. Unreachable through the
  // normal submit path for the same reason WEBSITE_TOKEN is - submitTask
  // refuses one outright - because the only thing that may credit it is
  // POST /tasks/:taskId/verify-youtube-subscription, which asks the YouTube
  // Data API, using the user's own Google grant, whether that user is
  // subscribed to the campaign's verified channel
  // (youtube-verification.service.ts). A self-confirmation click is exactly
  // the thing this strategy exists to replace, so reaching this entry at all
  // must fail closed rather than credit.
  YOUTUBE_SUBSCRIPTION: () => ({
    status: 'FAILED',
    reason: 'This task is verified through YouTube. Subscribe to the channel, then tap Verify Subscription.',
  }),
};

// Back-compat: tasks created before this strategy vocabulary existed may
// still carry the old ad-hoc `requiredAction` values.
const LEGACY_ALIASES: Record<string, VerificationStrategyName> = {
  SUBMIT_PROOF: 'API',
  SUBMIT_URL: 'URL',
};

function resolveStrategy(config: Record<string, unknown>): VerificationStrategyName {
  const named = config['verificationStrategy'];
  if (typeof named === 'string' && named in STRATEGIES) return named as VerificationStrategyName;

  const legacy = config['requiredAction'];
  if (typeof legacy === 'string' && legacy in LEGACY_ALIASES) return LEGACY_ALIASES[legacy];

  return 'USER_CONFIRMATION';
}

// Exported so callers that only need to know "is this a proof/admin-review
// task" (eligibility checks, the user-facing feed serializer) can ask the
// same question submitTask itself asks, instead of re-deriving it from
// campaign type codes in more than one place.
export function resolveTaskStrategy(task: Pick<Task, 'configuration'>): VerificationStrategyName {
  return resolveStrategy((task.configuration ?? {}) as Record<string, unknown>);
}

export function verifyTaskCompletion(task: Task, submissionData: Record<string, unknown>, context: VerificationContext): VerificationResult {
  const strategy = resolveTaskStrategy(task);
  return STRATEGIES[strategy](submissionData, context);
}
