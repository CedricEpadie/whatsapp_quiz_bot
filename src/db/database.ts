import { DatabaseSync, type StatementSync } from 'node:sqlite';
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
 *
 * --- Pourquoi node:sqlite et pas better-sqlite3 ni sql.js ---
 * better-sqlite3 est un module natif : il doit être recompilé (node-gyp)
 * pour la plateforme de déploiement, ce que beaucoup d'hébergeurs de bots
 * bloquent. On utilisait donc sql.js (SQLite compilé en WebAssembly, zéro
 * compilation native) en échange d'une contrepartie lourde à maintenir :
 * une base entièrement EN MÉMOIRE, à réexporter et réécrire intégralement
 * sur disque après chaque écriture.
 *
 * `node:sqlite` (module intégré à Node.js lui-même depuis la version
 * 22.5, stable sans flag depuis 22.13/23.4) règle les deux problèmes à la
 * fois : c'est un vrai moteur SQLite natif comme better-sqlite3 (fichier
 * sur disque, écritures directes et incrémentales, pas de réécriture
 * complète à chaque flush), mais compilé DANS le binaire Node lui-même —
 * donc aucune installation ni compilation côté hébergeur, exactement
 * comme pour n'importe quel autre module du cœur de Node (`fs`, `path`,
 * etc.). Nécessite Node.js >= 22.13 (>= 22.5 avec le flag
 * `--experimental-sqlite`).
 */

interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

// Retours volontairement typés `any`, à l'image de better-sqlite3 : c'est
// gameRepository.ts (avec ses `as GameRow`, `as PlayerRow[]`, etc.) qui
// porte la responsabilité du typage, exactement comme avant. Cela permet
// de changer de moteur SQLite sans toucher au reste du code.
interface StatementShim {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get: (...params: unknown[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  all: (...params: unknown[]) => any[];
  run: (...params: unknown[]) => RunResult;
}

interface DbShim {
  prepare: (sql: string) => StatementShim;
  exec: (sql: string) => void;
  pragma: (sql: string) => void;
}

function notInitialized(): never {
  throw new Error(
    "Base de données non initialisée : initDb() doit être attendu (await) avant toute utilisation de `db`."
  );
}

// Reste un objet "sûr" tant qu'initDb() n'a pas tourné, pour échouer vite
// et clairement plutôt que de planter avec une erreur obscure si un appel
// arrivait trop tôt.
export let db: DbShim = {
  prepare: notInitialized,
  exec: notInitialized,
  pragma: notInitialized,
};

let raw: DatabaseSync | undefined;

/**
 * Cache des statements compilés, indexé par le texte SQL exact. Simple
 * optimisation (évite de recompiler la même requête à chaque appel) :
 * contrairement à l'ancien shim sql.js, il n'y a ici aucune contrainte
 * d'invalidation — `node:sqlite` écrit directement sur disque à chaque
 * requête, il n'y a pas d'étape "export" qui finalise les statements en
 * cours de route.
 */
const stmtCache = new Map<string, StatementSync>();

function ensureDirExists(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function buildShim(rawDb: DatabaseSync): DbShim {
  function getCompiledStmt(sql: string): StatementSync {
    let stmt = stmtCache.get(sql);
    if (!stmt) {
      stmt = rawDb.prepare(sql);
      stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  return {
    prepare(sql: string): StatementShim {
      return {
        get(...params: unknown[]) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return getCompiledStmt(sql).get(...(params as any[]));
        },
        all(...params: unknown[]) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return getCompiledStmt(sql).all(...(params as any[])) as any[];
        },
        run(...params: unknown[]) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const info = getCompiledStmt(sql).run(...(params as any[]));
          // node:sqlite retourne des `number | bigint` (bigint seulement
          // si la valeur dépasse Number.MAX_SAFE_INTEGER, ce qui n'arrive
          // jamais ici vu les volumes en jeu) — on normalise en `number`
          // pour garder exactement le même contrat que l'ancien shim.
          return {
            changes: Number(info.changes),
            lastInsertRowid: Number(info.lastInsertRowid),
          };
        },
      };
    },
    exec(sql: string): void {
      rawDb.exec(sql);
    },
    pragma(sql: string): void {
      rawDb.exec(`PRAGMA ${sql}`);
    },
  };
}

/**
 * Exécute `fn` dans une transaction SQLite explicite (BEGIN/COMMIT,
 * ROLLBACK en cas d'erreur). Utile pour grouper plusieurs écritures
 * liées (ex: mettre à jour les points de tous les joueurs corrects
 * d'une question) en une seule unité, plutôt que N écritures
 * indépendantes.
 */
export function runInTransaction<T>(fn: () => T): T {
  db.exec('BEGIN TRANSACTION');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function columnExists(table: string): (column: string) => boolean {
  return (column: string) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    return cols.some((c) => c.name === column);
  };
}

/**
 * Ouvre (ou crée) le fichier SQLite via `node:sqlite`, et s'assure que
 * le schéma existe / est à jour. Le fichier est lu et écrit directement
 * sur disque par le moteur SQLite lui-même — pas de rechargement manuel
 * en mémoire à gérer ici (contrairement à l'ancien shim sql.js).
 *
 * Reste `async` (même si `node:sqlite` est entièrement synchrone) pour
 * ne pas devoir changer la signature attendue par les appelants
 * existants (voir src/index.ts : `await initDb()`).
 */
export async function initDb(filePath: string = config.dbPath): Promise<void> {
  ensureDirExists(filePath);

  raw = new DatabaseSync(filePath);

  // Sécurité si initDb() est rappelé avec une nouvelle connexion (ex: en
  // tests) : les statements déjà en cache seraient liés à l'ancienne
  // connexion désormais fermée/obsolète.
  stmtCache.clear();

  db = buildShim(raw);
  db.pragma('foreign_keys = ON');
  // WAL : plusieurs lecteurs/écrivains concurrents ne posent aucun
  // problème pour ce bot (un seul process y accède), mais WAL réduit
  // aussi la latence des écritures synchrones (une seule fsync en fin de
  // checkpoint plutôt qu'à chaque transaction) — gratuit à activer ici.
  db.pragma('journal_mode = WAL');

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
  const gamesHasColumn = columnExists('games');
  const answersHasColumn = columnExists('answers');
  if (!gamesHasColumn('phase_count')) {
    db.exec('ALTER TABLE games ADD COLUMN phase_count INTEGER NOT NULL DEFAULT 6');
  }
  if (!answersHasColumn('message_key')) {
    db.exec('ALTER TABLE answers ADD COLUMN message_key TEXT');
  }
}

/**
 * Conservée pour ne pas devoir modifier ses appelants (voir
 * src/index.ts, appelée à l'arrêt du process). Ne fait plus rien : avec
 * `node:sqlite`, chaque écriture est déjà directement persistée sur
 * disque par le moteur SQLite lui-même (comme better-sqlite3), il n'y a
 * plus de tampon en mémoire à vider manuellement (contrairement à
 * l'ancien shim sql.js).
 */
export function flushDbToDisk(): void {
  // no-op intentionnel — voir commentaire ci-dessus.
}