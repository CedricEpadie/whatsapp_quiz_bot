import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { config } from '../config/config';

/**
 * Le state "vivant" d'une question en cours (timers, callbacks) reste en
 * mémoire process (voir game/gameManager.ts) : il n'a pas de sens de le
 * persister puisqu'une coupure de connexion entraîne l'annulation propre
 * de la partie (décision produit). SQLite sert ici de source de vérité
 * pour tout ce qui doit survivre à la partie et permettre les calculs de
 * classement/scores/historique de façon fiable et requêtable.
 */

function ensureDirExists(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

ensureDirExists(config.dbPath);

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN
      ('registration', 'running', 'finished', 'cancelled')),
    phase_count INTEGER NOT NULL DEFAULT 6,
    current_phase INTEGER NOT NULL DEFAULT 0,
    current_question INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    ended_at INTEGER
  );

  -- Un seul index partiel : au plus une partie active (registration/running)
  -- par groupe. Empêche le double lancement au niveau base, en plus du
  -- contrôle applicatif dans commandRouter.ts.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_game_per_group
    ON games (group_id)
    WHERE status IN ('registration', 'running');

  CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    jid TEXT NOT NULL,
    display_name TEXT NOT NULL,
    registered_at INTEGER NOT NULL,
    UNIQUE (game_id, jid)
  );

  CREATE TABLE IF NOT EXISTS answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    phase INTEGER NOT NULL,
    question_index INTEGER NOT NULL,
    choice TEXT NOT NULL,
    is_correct INTEGER NOT NULL,
    points INTEGER NOT NULL DEFAULT 0,
    speed_bonus INTEGER NOT NULL DEFAULT 0,
    message_key TEXT,
    answered_at INTEGER NOT NULL,
    -- Rejoue le rôle "seule la première réponse valide d'un joueur compte" :
    -- une deuxième tentative sur la même question viole cette contrainte
    -- et est donc rejetée nativement par la base.
    UNIQUE (game_id, player_id, phase, question_index)
  );

  CREATE TABLE IF NOT EXISTS phase_bonuses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    phase INTEGER NOT NULL,
    points INTEGER NOT NULL,
    UNIQUE (game_id, player_id, phase)
  );

  CREATE INDEX IF NOT EXISTS idx_answers_game_phase_question
    ON answers (game_id, phase, question_index);
`);

// --- Migration douce pour les bases créées par une version antérieure du
// bot, qui n'avaient pas encore ces colonnes. Sans effet sur une base
// fraîche (les CREATE TABLE ci-dessus les incluent déjà).
function columnExists(table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === column);
}
if (!columnExists('games', 'phase_count')) {
  db.exec('ALTER TABLE games ADD COLUMN phase_count INTEGER NOT NULL DEFAULT 6');
}
if (!columnExists('answers', 'message_key')) {
  db.exec('ALTER TABLE answers ADD COLUMN message_key TEXT');
}
