import { Errors } from '../../utils/AppError.js';

// Single source of truth for "what extra data does this campaign type need
// beyond the common fields every campaign already has" (campaignName,
// description, destinationUrl, completionLimit, the creative image upload).
// Drives three things from one definition instead of three hand-kept
// copies: the Agent form renders these fields dynamically (via
// GET /campaigns/types, which now includes `fields`), createTask/updateTask
// validate a submitted `configuration` against them, and Admin/Ionic read
// the same `label`s to display whatever a task's configuration holds.
// Adding an eleventh... twelfth campaign type later means adding one entry
// here, not touching the form component, validation, or display code.

export type FieldKind = 'text' | 'url' | 'textarea' | 'number' | 'select';

export interface CampaignTypeField {
  key: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  options?: string[]; // for 'select'
  // Only rendered/required when another field in the same configuration
  // already equals one of these values - e.g. watchDurationSeconds only
  // matters once requiredAction is Watch or View.
  showWhen?: { field: string; equals: string[] };
}

// Per-type policy for the *existing* generic URL columns every campaign
// already has (Campaign.destinationUrl, Campaign.videoUrl) - not a new
// field, just per-type control over whether that existing column is
// required, what it's called in the UI, and (for VIDEO only) which of the
// two existing columns it actually is.
export interface CampaignUrlPolicy {
  field: 'destinationUrl' | 'videoUrl';
  label: string;
  required: boolean;
}

export interface CampaignTypeDef {
  fields: CampaignTypeField[];
  url: CampaignUrlPolicy;
}

const WATCH_DURATION_OPTIONS = ['30', '60', '120'];

export const CAMPAIGN_TYPE_FIELDS: Record<string, CampaignTypeDef> = {
  APP_PROMOTION: {
    fields: [{ key: 'appName', label: 'App Name', kind: 'text', required: true }],
    url: { field: 'destinationUrl', label: 'App Store / Play Store URL', required: true },
  },
  // Banner/Image Promotion needs nothing beyond the common fields (name,
  // description, the creative image upload) - deliberately the simplest
  // type, not padded with unused fields. Destination URL stays optional -
  // a banner doesn't have to link anywhere.
  BANNER_IMAGE: { fields: [], url: { field: 'destinationUrl', label: 'Url Link (optional)', required: false } },
  FACEBOOK_PAGE_LIKE: {
    fields: [
      { key: 'pageName', label: 'Facebook Page Name', kind: 'text', required: true },
      { key: 'requiredAction', label: 'Required Action', kind: 'select', required: true, options: ['Follow', 'Like'] },
    ],
    url: { field: 'destinationUrl', label: 'Facebook Page URL', required: true },
  },
  FACEBOOK_PROMOTION: {
    fields: [
      { key: 'contentName', label: 'Content / Page Name', kind: 'text', required: false },
      { key: 'requiredAction', label: 'Required Action', kind: 'select', required: true, options: ['View', 'Like', 'Share'] },
    ],
    url: { field: 'destinationUrl', label: 'Facebook URL', required: true },
  },
  INSTAGRAM_FOLLOW: {
    fields: [{ key: 'instagramName', label: 'Instagram Username', kind: 'text', required: true }],
    url: { field: 'destinationUrl', label: 'Instagram Profile URL', required: true },
  },
  PRODUCT_PROMOTION: {
    fields: [
      { key: 'productName', label: 'Product Name', kind: 'text', required: true },
      { key: 'productPrice', label: 'Product Price', kind: 'number', required: true },
      { key: 'discountPrice', label: 'Discount Price', kind: 'number', required: false },
      { key: 'brandName', label: 'Brand Name', kind: 'text', required: false },
      { key: 'sku', label: 'SKU', kind: 'text', required: false },
      { key: 'ctaText', label: 'CTA Text', kind: 'text', required: false },
    ],
    // Deliberately optional (spec: "An Agent should be able to create a
    // product campaign without an external URL") - unlike every social
    // type above, a product doesn't require anywhere to send the user.
    url: { field: 'destinationUrl', label: 'Product URL (optional)', required: false },
  },
  SURVEY: { fields: [], url: { field: 'destinationUrl', label: 'Destination URL (optional)', required: false } },
  TASK: { fields: [], url: { field: 'destinationUrl', label: 'Reference URL (optional)', required: false } },
  // Same shape as Banner/Image Promotion, deliberately - no fields beyond
  // the common ones (name, description, the shared image upload), same
  // fixed 30s dwell time (campaign-tasks.service.ts), the only difference
  // being which existing URL column its link uses. Used to carry
  // watchDurationSeconds/ctaText fields of its own; removed so the Agent
  // form (a SIMPLIFIED_TYPE, same as Banner) shows nothing beyond what
  // Banner shows.
  VIDEO: {
    fields: [],
    // The one type whose URL is the video itself, not a generic click-
    // through destination - reuses Campaign.videoUrl (already existed,
    // already serialized to every client, just never had a form control
    // pointed at it before this).
    url: { field: 'videoUrl', label: 'Video URL', required: true },
  },
  WEBSITE_PROMOTION: {
    fields: [
      { key: 'websiteName', label: 'Website Name or Title', kind: 'text', required: true },
      // Genuinely enforced now (TIME_ON_SITE strategy - verification.service.ts),
      // unlike its predecessor field of the same name which was purely
      // descriptive and got removed earlier this session.
      { key: 'visitDurationSeconds', label: 'Required Visit Duration (seconds)', kind: 'select', required: true, options: WATCH_DURATION_OPTIONS },
    ],
    url: { field: 'destinationUrl', label: 'Website URL', required: true },
  },
  YOUTUBE_PROMOTION: {
    fields: [{ key: 'channelName', label: 'Channel Name', kind: 'text', required: true }],
    url: { field: 'destinationUrl', label: 'Channel URL', required: true },
  },
  // The one type with NO agent-entered fields at all, on purpose: both the
  // channel name and the destination URL are copied from the agent's
  // OAuth-verified YouTubeConnection at create/update time
  // (campaigns.service.ts). Letting an agent type either one would defeat the
  // entire point - a campaign whose target channel is only as trustworthy as
  // the text box it came from cannot be verified against, so `required:
  // false` here means "the agent does not supply it", not "it is optional".
  YOUTUBE_SUBSCRIBE: { fields: [], url: { field: 'destinationUrl', label: 'Channel URL (from your connected YouTube account)', required: false } },
};

export function getCampaignTypeFields(code: string): CampaignTypeField[] {
  return CAMPAIGN_TYPE_FIELDS[code]?.fields ?? [];
}

export function getCampaignUrlPolicy(code: string): CampaignUrlPolicy {
  return CAMPAIGN_TYPE_FIELDS[code]?.url ?? { field: 'destinationUrl', label: 'Destination URL', required: false };
}

// Backend-authoritative check for the campaign-level URL column (spec §28's
// per-type required/optional table) - called from createDraft/updateDraft,
// separate from validateTypeMetadata below since this governs an existing
// top-level Campaign column, not a Task.configuration key.
export function validateCampaignUrl(campaignTypeCode: string, input: { destinationUrl?: string | null; videoUrl?: string | null }): void {
  const policy = getCampaignUrlPolicy(campaignTypeCode);
  const value = policy.field === 'videoUrl' ? input.videoUrl : input.destinationUrl;
  if (policy.required && !value) {
    throw Errors.validation(`${policy.label} is required for this campaign type.`);
  }
}

// --- Survey questions ----------------------------------------------------
// A real (if minimal) question builder, stored as Task.configuration.
// questions - the one Task.configuration key that's a structured array
// instead of a flat scalar, since a survey's whole point is a variable
// number of questions.

export type SurveyQuestionType = 'SINGLE_CHOICE' | 'MULTIPLE_CHOICE' | 'TEXT' | 'YES_NO';

export interface SurveyQuestion {
  text: string;
  type: SurveyQuestionType;
  options?: string[];
  required: boolean;
}

export function validateSurveyQuestions(questions: unknown): SurveyQuestion[] {
  if (!Array.isArray(questions) || questions.length === 0) {
    throw Errors.validation('At least one survey question is required.');
  }
  return questions.map((q, i) => {
    const question = q as Partial<SurveyQuestion>;
    if (!question.text || typeof question.text !== 'string' || !question.text.trim()) {
      throw Errors.validation(`Question ${i + 1}: text is required.`);
    }
    const type = question.type;
    if (type !== 'SINGLE_CHOICE' && type !== 'MULTIPLE_CHOICE' && type !== 'TEXT' && type !== 'YES_NO') {
      throw Errors.validation(`Question ${i + 1}: invalid question type.`);
    }
    const needsOptions = type === 'SINGLE_CHOICE' || type === 'MULTIPLE_CHOICE';
    const options = Array.isArray(question.options) ? question.options.map(String).filter((o) => o.trim()) : [];
    if (needsOptions && options.length < 2) {
      throw Errors.validation(`Question ${i + 1}: at least two options are required for a choice question.`);
    }
    return {
      text: question.text.trim(),
      type,
      ...(needsOptions ? { options } : {}),
      required: question.required !== false,
    };
  });
}

// Backend-authoritative validation - the Agent form renders/requires the
// same fields client-side, but a direct API call must be checked here too
// (spec §20: "Do not rely only on Angular frontend validation").
export function validateTypeMetadata(campaignTypeCode: string, metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  const fields = getCampaignTypeFields(campaignTypeCode);
  const input = metadata ?? {};
  const cleaned: Record<string, unknown> = {};

  for (const field of fields) {
    const value = input[field.key];
    const conditionMet = !field.showWhen || field.showWhen.equals.includes(String(input[field.showWhen.field] ?? ''));
    const isRequired = field.required && conditionMet;

    if (value === undefined || value === null || value === '') {
      if (isRequired) throw Errors.validation(`${field.label} is required for this campaign type.`);
      continue;
    }

    if (field.kind === 'select' && field.options && !field.options.includes(String(value))) {
      throw Errors.validation(`${field.label} must be one of: ${field.options.join(', ')}.`);
    }
    if (field.kind === 'number' && Number.isNaN(Number(value))) {
      throw Errors.validation(`${field.label} must be a number.`);
    }
    if (field.kind === 'url' && !/^https?:\/\/.+/.test(String(value))) {
      throw Errors.validation(`${field.label} must be a valid URL.`);
    }

    cleaned[field.key] = field.kind === 'number' ? Number(value) : value;
  }

  return cleaned;
}
