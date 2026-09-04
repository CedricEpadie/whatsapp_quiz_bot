import { config } from '../config/config';
import { runInTransaction } from '../db/database';
import {
  addPhaseBonus,
  getCorrectAnswersOrdered,
  getWrongAnswerPlayerIds,
  getPerfectPhasePlayers,
  getPlayerCount,
  getPlayers,
  getScoreboard,
  updateAnswerPoints,
  type PlayerScoreRow,
} from '../db/gameRepository';

/**
 * Une ligne par joueur INSCRIT à la partie (pas seulement ceux qui ont
 * répondu correctement) : le produit veut un récapitulatif à TROIS
 * états par question — ✅ trouvé, ❌ répondu mais faux, ➖ pas répondu du
 * tout — plutôt qu'une réaction ✅/❌ individuelle sur chaque message de
 * réponse (voir game/questionRunner.tryHandleAnswer, qui réagit
 * uniquement avec 🔄 pour accuser réception, sans révéler la correction
 * avant la fin du décompte).
 */
export type QuestionOutcome = 'correct' | 'wrong' | 'no_answer';

export interface QuestionSummaryEntry {
  playerId: number;
  outcome: QuestionOutcome;
  points: number;
  speedBonus: number;
  /** true si ce point provient du barème "majorité ratée" (voir config.majorityMissThreshold). */
  majorityBonus: boolean;
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
 * Retourne une entrée par joueur INSCRIT (correct, faux, ou absent de
 * réponse) pour construire le récapitulatif de fin de question envoyé
 * en un seul message groupé, plutôt qu'une réaction individuelle par
 * réponse. Les joueurs corrects sont en tête (dans l'ordre de rapidité),
 * suivis des joueurs en échec (répondu faux, puis pas répondu), dans
 * l'ordre d'inscription au sein de chaque groupe.
 */
export function settleQuestionScores(
  gameId: number,
  phase: number,
  questionIndex: number
): { summary: QuestionSummaryEntry[]; majorityMissed: boolean } {
  const correctAnswers = getCorrectAnswersOrdered(gameId, phase, questionIndex);
  const totalPlayers = getPlayerCount(gameId);
  const speedBonusActive = totalPlayers >= config.speedBonusMinPlayers;

  const missCount = totalPlayers - correctAnswers.length;
  const missRate = totalPlayers > 0 ? missCount / totalPlayers : 0;
  const majorityMissed = missRate >= config.majorityMissThreshold;
  const basePoints = majorityMissed ? config.points.majorityMissBonus : config.points.correctAnswer;

  const summary: QuestionSummaryEntry[] = [];
  const correctPlayerIds = new Set<number>();

  // Une seule transaction pour les N mises à jour au lieu de N écritures
  // indépendantes — évite N cycles bind/step/reset séparés quand
  // beaucoup de joueurs ont répondu correctement à la même question.
  runInTransaction(() => {
    correctAnswers.forEach((answer, index) => {
      const isFastest = speedBonusActive && index < config.points.speedBonusRankCount;
      const speedBonus = isFastest ? config.points.speedBonus : 0;
      const points = basePoints + speedBonus;
      updateAnswerPoints(answer.id, points, speedBonus);
      correctPlayerIds.add(answer.player_id);
      summary.push({
        playerId: answer.player_id,
        outcome: 'correct',
        points,
        speedBonus,
        majorityBonus: majorityMissed,
      });
    });
  });

  // Joueurs ayant répondu FAUX : présents dans `answers` mais pas dans
  // `correctPlayerIds`.
  const wrongPlayerIds = new Set(
    getWrongAnswerPlayerIds(gameId, phase, questionIndex).filter((id) => !correctPlayerIds.has(id))
  );
  for (const playerId of wrongPlayerIds) {
    summary.push({ playerId, outcome: 'wrong', points: 0, speedBonus: 0, majorityBonus: false });
  }

  // Le reste des joueurs inscrits n'a tout simplement pas répondu.
  for (const player of getPlayers(gameId)) {
    if (!correctPlayerIds.has(player.id) && !wrongPlayerIds.has(player.id)) {
      summary.push({ playerId: player.id, outcome: 'no_answer', points: 0, speedBonus: 0, majorityBonus: false });
    }
  }

  return { summary, majorityMissed };
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
  runInTransaction(() => {
    for (const playerId of perfectPlayerIds) {
      addPhaseBonus(gameId, playerId, phase, config.points.perfectPhaseBonus);
    }
  });
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