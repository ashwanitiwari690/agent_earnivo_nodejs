import { prisma } from '../../db/prisma.js';
import { paginationMeta } from '../../utils/pagination.js';

interface SurveyQuestion {
  text: string;
  type: 'SINGLE_CHOICE' | 'MULTIPLE_CHOICE' | 'TEXT' | 'YES_NO';
  options?: string[];
  required: boolean;
}

// Individual survey responses (spec decision: response-level, not a
// survey-campaign summary list) - reuses the exact same UserTaskCompletion
// rows and Task.configuration.questions shape the Ionic survey UI and
// campaign-tasks.service.ts's validateSurveyQuestions already define, and
// the exact `verificationData.answers` shape angular-ionic's
// campaign-detail.page.ts submits (a map of question index -> answer).
// Only SUBMITTED/COMPLETED completions are real responses - STARTED means
// the user opened the task but never answered anything yet.
export async function listSurveyResponses(params: { page: number; pageSize: number; search?: string }) {
  const where: any = {
    campaign: { campaignType: { code: 'SURVEY' } },
    status: { in: ['SUBMITTED', 'COMPLETED'] },
    ...(params.search
      ? {
          OR: [
            { user: { name: { contains: params.search, mode: 'insensitive' } } },
            { user: { phone: { contains: params.search, mode: 'insensitive' } } },
            { campaign: { campaignName: { contains: params.search, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.userTaskCompletion.findMany({
      where,
      include: {
        user: { select: { id: true, name: true, phone: true, email: true } },
        campaign: { select: { id: true, campaignName: true } },
        task: { select: { id: true, title: true, configuration: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
    }),
    prisma.userTaskCompletion.count({ where }),
  ]);

  const data = rows.map((r) => {
    const questions = ((r.task.configuration as any)?.questions ?? []) as SurveyQuestion[];
    const answers = ((r.verificationData as any)?.answers ?? {}) as Record<string, string | string[]>;
    const responses = questions.map((q, i) => ({ question: q.text, answer: answers[String(i)] ?? null }));

    return {
      id: r.id,
      user: r.user,
      campaign: r.campaign,
      surveyTitle: r.task.title,
      questionCount: questions.length,
      answeredCount: responses.filter((r2) => r2.answer !== null).length,
      status: r.status,
      submittedAt: r.submittedAt,
      responses,
    };
  });

  return { data, page: params.page, pageSize: params.pageSize, total, pagination: paginationMeta(params.page, params.pageSize, total) };
}
