import { Request, Response } from 'express';
import * as gamesService from './games.service.js';

export async function listGamesHandler(_req: Request, res: Response) {
  const games = await gamesService.listActiveGames();
  res.json({ success: true, data: games });
}

export async function redeemGameRewardHandler(req: Request, res: Response) {
  const result = await gamesService.redeemGameReward(req.body);
  res.status(201).json({ success: true, data: result });
}
