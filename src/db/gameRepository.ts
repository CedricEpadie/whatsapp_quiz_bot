import { db } from './database';
import type { WAMessageKey } from '@whiskeysockets/baileys';

export type GameStatus = 'registration' | 'running' | 'finished' | 'cancelled';

export interface GameRow {
  id: number;
  group_id: string;
  status: GameStatus;
  phase_count: number;
  current_phase: number;
  current_question: number;
  created_at: number;
  ended_at: number | null;
}

export interface PlayerRow {
  id: number;
  game_id: number;
  jid: string;
  display_name: string;
  registered_at: number;
}

export interface PlayerScoreRow {
  player_id: number;
  jid: string;
  display_name: string;
  total_points: number;
  speed_bonus_count: number;
}

/** Retourne la partie active (registration|running) d'un groupe, si elle existe. */
export function getActiveGame(groupId: string): GameRow | undefined {
  return db
    .prepare(
      `SELECT * FROM games
       WHERE group_id = ? AND status IN ('registration', 'running')
       LIMIT 1`
    )
    .get(groupId) as GameRow | undefined;
}

export function createGame(groupId: string, phaseCount: number): GameRow {
  const info = db
    .prepare(
      `INSERT INTO games (group_id, status, phase_count, current_phase, current_question, created_at)
       VALUES (?, 'registration', ?, 0, 0, ?)`
    )
    .run(groupId, phaseCount, Date.now());
  return db
    .prepare('SELECT * FROM games WHERE id = ?')
    .get(info.lastInsertRowid) as GameRow;
}

export function setGameStatus(gameId: number, status: GameStatus): void {
  const endedAt = status === 'finished' || status === 'cancelled' ? Date.now() : null;
  db.prepare('UPDATE games SET status = ?, ended_at = ? WHERE id = ?').run(
    status,
    endedAt,
    gameId
  );
}

export function setGameProgress(
  gameId: number,
  currentPhase: number,
  currentQuestion: number
): void {
  db.prepare(
    'UPDATE games SET current_phase = ?, current_question = ? WHERE id = ?'
  ).run(currentPhase, currentQuestion, gameId);
}

export function registerPlayer(
  gameId: number,
  jid: string,
  displayName: string
): PlayerRow | null {
  try {
    const info = db
      .prepare(
        `INSERT INTO players (game_id, jid, display_name, registered_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(gameId, jid, displayName, Date.now());
    return db
      .prepare('SELECT * FROM players WHERE id = ?')
      .get(info.lastInsertRowid) as PlayerRow;
  } catch {
    // Joueur déjà inscrit (contrainte UNIQUE game_id+jid) -> inscription ignorée
    return null;
  }
}

export function getPlayers(gameId: number): PlayerRow[] {
  return db
    .prepare('SELECT * FROM players WHERE game_id = ? ORDER BY registered_at ASC')
    .all(gameId) as PlayerRow[];
}

export function getPlayerCount(gameId: number): number {
  const row = db
    .prepare('SELECT COUNT(*) as count FROM players WHERE game_id = ?')
    .get(gameId) as { count: number };
  return row.count;
}

/**
 * Marqueur du message d'erreur levé par sql.js quand une contrainte
 * UNIQUE est violée (sql.js n'expose pas de classe d'erreur typée avec
 * un `.code` comme better-sqlite3 : on doit distinguer par le message).
 */
const UNIQUE_CONSTRAINT_MARKER = 'UNIQUE constraint failed';

/**
 * Enregistre une réponse. Grâce à la contrainte UNIQUE(game_id, player_id,
 * phase, question_index), une deuxième tentative du même joueur sur la
 * même question viole cette contrainte : c'est le SEUL cas où l'échec est
 * normal et attendu ("seule la première réponse valide est prise en
 * compte"), donc le seul cas où on retourne silencieusement `false`.
 * Toute autre erreur (base verrouillée, contrainte de clé étrangère,
 * etc.) est anormale et est repropagée : l'avaler ferait perdre une
 * réponse valide sans que personne ne s'en aperçoive, alors que
 * l'appelant a déjà marqué le joueur comme "a répondu" en mémoire.
 */
export function recordAnswer(params: {
  gameId: number;
  playerId: number;
  phase: number;
  questionIndex: number;
  choice: string;
  isCorrect: boolean;
  answeredAt: number;
  messageKey?: WAMessageKey;
}): boolean {
  try {
    db.prepare(
      `INSERT INTO answers
         (game_id, player_id, phase, question_index, choice, is_correct, points, speed_bonus, message_key, answered_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`
    ).run(
      params.gameId,
      params.playerId,
      params.phase,
      params.questionIndex,
      params.choice,
      params.isCorrect ? 1 : 0,
      params.messageKey ? JSON.stringify(params.messageKey) : null,
      params.answeredAt
    );
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes(UNIQUE_CONSTRAINT_MARKER)) {
      return false; // vrai doublon : comportement voulu
    }
    throw err; // erreur anormale : ne pas la masquer
  }
}

/**
 * Retourne les réponses CORRECTES d'une question, triées par ordre
 * d'arrivée (answered_at ASC, puis id ASC comme départage stable pour
 * les cas d'égalité de timestamp — voir utils/timer.ts / questionRunner.ts
 * pour la garantie d'ordre d'insertion séquentiel).
 */
export function getCorrectAnswersOrdered(
  gameId: number,
  phase: number,
  questionIndex: number
): { id: number; player_id: number; answered_at: number }[] {
  return db
    .prepare(
      `SELECT id, player_id, answered_at FROM answers
       WHERE game_id = ? AND phase = ? AND question_index = ? AND is_correct = 1
       ORDER BY answered_at ASC, id ASC`
    )
    .all(gameId, phase, questionIndex) as {
    id: number;
    player_id: number;
    answered_at: number;
  }[];
}

export function updateAnswerPoints(
  answerId: number,
  points: number,
  speedBonus: number
): void {
  db.prepare('UPDATE answers SET points = ?, speed_bonus = ? WHERE id = ?').run(
    points,
    speedBonus,
    answerId
  );
}

/** Joueurs ayant répondu correctement aux N questions d'une phase (sans-faute). */
export function getPerfectPhasePlayers(
  gameId: number,
  phase: number,
  questionsPerPhase: number
): number[] {
  const rows = db
    .prepare(
      `SELECT player_id FROM answers
       WHERE game_id = ? AND phase = ? AND is_correct = 1
       GROUP BY player_id
       HAVING COUNT(*) = ?`
    )
    .all(gameId, phase, questionsPerPhase) as { player_id: number }[];
  return rows.map((r) => r.player_id);
}

export function addPhaseBonus(gameId: number, playerId: number, phase: number, points: number): void {
  db.prepare(
    `INSERT OR IGNORE INTO phase_bonuses (game_id, player_id, phase, points)
     VALUES (?, ?, ?, ?)`
  ).run(gameId, playerId, phase, points);
}

/**
 * Score total = somme des points de réponses + somme des bonus de phase.
 * C'est la requête utilisée pour tous les classements (fin de phase et
 * fin de partie).
 */
export function getScoreboard(gameId: number): PlayerScoreRow[] {
  return db
    .prepare(
      `SELECT
         p.id AS player_id,
         p.jid AS jid,
         p.display_name AS display_name,
         COALESCE(SUM(a.points), 0) + COALESCE(pb.total_phase_bonus, 0) AS total_points,
         COALESCE(SUM(a.speed_bonus), 0) AS speed_bonus_count
       FROM players p
       LEFT JOIN answers a ON a.player_id = p.id AND a.game_id = p.game_id
       LEFT JOIN (
         SELECT player_id, SUM(points) AS total_phase_bonus
         FROM phase_bonuses WHERE game_id = ?
         GROUP BY player_id
       ) pb ON pb.player_id = p.id
       WHERE p.game_id = ?
       GROUP BY p.id
       ORDER BY total_points DESC, speed_bonus_count DESC`
    )
    .all(gameId, gameId) as PlayerScoreRow[];
}