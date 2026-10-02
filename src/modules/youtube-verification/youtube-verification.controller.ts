import { Request, Response } from 'express';
import * as youtubeVerification from './youtube-verification.service.js';

// Always 200 with `success: true`, whether or not the subscription was found
// (spec §11/§12). "Not subscribed yet" is a legitimate answer to a question
// the user is allowed to keep asking, not a failed request - reserving the
// error envelope for things that actually went wrong is what lets the app
// tell the two apart without parsing messages.
export async function verifyYouTubeSubscriptionHandler(req: Request, res: Response) {
  const result = await youtubeVerification.verifySubscription(req.user!.id, req.params.taskId as string);
  res.json({ success: true, data: result });
}
