import { Request, Response } from 'express';
import * as adminGamesService from './admin-games.service.js';

export async function listGamesHandler(_req: Request, res: Response) {
  const games = await adminGamesService.listGames();
  res.json({ success: true, data: games });
}

export async function createGameHandler(req: Request, res: Response) {
  const game = await adminGamesService.createGame(req.user!.id, req.body);
  res.status(201).json({ success: true, data: game });
}

export async function updateGameHandler(req: Request, res: Response) {
  const game = await adminGamesService.updateGame(req.user!.id, req.params.code as string, req.body);
  res.json({ success: true, data: game });
}

export async function listConversionsHandler(req: Request, res: Response) {
  const query = req.validatedQuery as { page: number; pageSize: number; gameCode?: string; userId?: string; status?: string };
  const result = await adminGamesService.listConversions(query);
  res.json({ success: true, ...result });
}
