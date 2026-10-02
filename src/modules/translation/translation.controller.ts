import { Request, Response } from 'express';
import { Errors } from '../../utils/AppError.js';
import { translateText } from './translation.service.js';

export async function translateHandler(req: Request, res: Response) {
  const { text, target } = req.query;
  if (typeof text !== 'string' || !text.trim()) throw Errors.validation('text is required.');
  const targetLang = typeof target === 'string' && target.trim() ? target.trim() : 'hi';

  const translatedText = await translateText(text, targetLang);
  res.json({ success: true, data: { translatedText } });
}
