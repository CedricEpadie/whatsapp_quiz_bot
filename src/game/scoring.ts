import { config } from '../config/config';
import {
  addPhaseBonus,
  getCorrectAnswersOrdered,
  getPerfectPhasePlayers,
  getPlayerCount,
  getScoreboard,
  updateAnswerPoints,
  type PlayerScoreRow,
} from '../db/gameRepository';

export interface ScoredAnswer {
  playerId: number;
  points: number;
  speedBonus: number;
}

/**
 * Attribue les points d'une question qui vient de se terminer :
 * - base = correctAnswer, SAUF si `majorityMissThreshold` (90% par
 *   défaut) des joueurs inscrits ont raté (mauvaise réponse OU pas de
 *   réponse) la question, auquel cas base = majorityMissBonus (+4)
 * - +speedBonus aux N premiers corrects (par answered_at ASC, id ASC —
 *   ordre déjà garanti fiable par getCorrectAnswersOrdered), uniquement
 *   si le nombre de joueurs inscrits atteint le seuil configuré
 *
 * Retourne le détail par joueur pour construire le message d'annonce
 * ("+X pour @joueur ...") sans requête supplémentaire.
 */
export function settleQuestionScores(
  gameId: number,
  phase: number,
  questionIndex: number
): { scored: ScoredAnswer[]; majorityMissed: boolean } {
  const correctAnswers = getCorrectAnswersOrdered(gameId, phase, questionIndex);
  const totalPlayers = getPlayerCount(gameId);
  const speedBonusActive = totalPlayers >= config.speedBonusMinPlayers;

  const missCount = totalPlayers - correctAnswers.length;
  const missRate = totalPlayers > 0 ? missCount / totalPlayers : 0;
  const majorityMissed = missRate >= config.majorityMissThreshold;
  const basePoints = majorityMissed ? config.points.majorityMissBonus : config.points.correctAnswer;

  const scored: ScoredAnswer[] = [];

  correctAnswers.forEach((answer, index) => {
    const isFastest = speedBonusActive && index < config.points.speedBonusRankCount;
    const speedBonus = isFastest ? config.points.speedBonus : 0;
    const points = basePoints + speedBonus;
    updateAnswerPoints(answer.id, points, speedBonus);
    scored.push({ playerId: answer.player_id, points, speedBonus });
  });

  return { scored, majorityMissed };
}

/**
 * Applique le bonus sans-faute de fin de phase (+5 pts) à tous les
 * joueurs ayant répondu correctement aux `questionsPerPhase` questions
 * de la phase. Idempotent grâce à la contrainte UNIQUE(game_id, player_id, phase)
 * sur phase_bonuses (addPhaseBonus utilise INSERT OR IGNORE).
 */
export function applyPerfectPhaseBonus(
  gameId: number,
  phase: number
): { perfectPlayerIds: number[] } {
  const perfectPlayerIds = getPerfectPhasePlayers(gameId, phase, config.questionsPerPhase);
  for (const playerId of perfectPlayerIds) {
    addPhaseBonus(gameId, playerId, phase, config.points.perfectPhaseBonus);
  }
  return { perfectPlayerIds };
}

export function getCurrentScoreboard(gameId: number): PlayerScoreRow[] {
  return getScoreboard(gameId);
}

/**
 * Détermine le(s) gagnant(s) en tête, avec départage par nombre total de
 * bonus de rapidité obtenus sur la partie. Si l'égalité persiste même
 * après ce critère, tous les joueurs à égalité en tête sont déclarés
 * co-gagnants.
 */
export function determineWinners(scoreboard: PlayerScoreRow[]): PlayerScoreRow[] {
  if (scoreboard.length === 0) return [];

  const topScore = scoreboard[0].total_points;
  const topScorers = scoreboard.filter((p) => p.total_points === topScore);

  if (topScorers.length === 1) return topScorers;

  const topSpeedBonus = Math.max(...topScorers.map((p) => p.speed_bonus_count));
  const finalists = topScorers.filter((p) => p.speed_bonus_count === topSpeedBonus);

  return finalists; // 1 = gagnant unique, >1 = co-gagnants
}
