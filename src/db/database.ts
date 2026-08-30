import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
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
 * --- Pourquoi sql.js et pas better-sqlite3 ---
 * better-sqlite3 est un module natif : il doit être recompilé (node-gyp)
 * pour la plateforme de déploiement. Beaucoup d'hébergeurs de bots
 * bloquent ou n'autorisent pas ce type de build. sql.js est SQLite
 * compilé en WebAssembly : aucune compilation native n'est nécessaire,
 * au prix d'une contrepartie qu'il faut gérer explicitement ici :
 * sql.js travaille entièrement EN MÉMOIRE et n'écrit jamais seul sur
 * disque. C'est donc ce module qui est responsable de recharger le
 * fichier .db au démarrage et de le réécrire après chaque écriture
 * (voir schedulePersist / flushDbToDisk plus bas).
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
// et clairement plutôt que de planter avec une erreur sql.js obscure si
// un appel arrivait trop tôt.
export let db: DbShim = {
  prepare: notInitialized,
  exec: notInitialized,
  pragma: notInitialized,
};

let raw: SqlJsDatabase | undefined;
let dbFilePath = '';
let saveTimer: NodeJS.Timeout | undefined;

function ensureDirExists(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Persistance différée (debounce 500ms) pour absorber les rafales
 * d'écritures (ex: plusieurs joueurs qui répondent en même temps) sans
 * réécrire le fichier entier à chaque INSERT. */
function schedulePersist(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    persistNow();
  }, 500);
}

function persistNow(): void {
  if (!raw) return;
  const data = raw.export();
  fs.writeFileSync(dbFilePath, Buffer.from(data));
}

/** À appeler explicitement à l'arrêt du process pour ne pas perdre les
 * dernières écritures encore en attente dans le debounce. */
export function flushDbToDisk(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = undefined;
  }
  persistNow();
}

function buildShim(rawDb: SqlJsDatabase): DbShim {
  // Cache des statements compilés, indexés par le texte SQL exact. Sans ce
  // cache, chaque appel à `.prepare(sql)` recompile le SQL via WASM — un
  // coût répété inutilement pour des requêtes identiques exécutées en
  // rafale (ex: plusieurs joueurs qui répondent à la même seconde).
  //
  // Sûr à réutiliser tel quel : tout le code de ce fichier est synchrone
  // de bout en bout (bind → step → reset se termine avant tout `await`
  // suivant), donc deux appels ne peuvent jamais s'entrelacer sur le même
  // statement. On utilise `stmt.reset()` au lieu de `stmt.free()` pour
  // remettre le statement dans un état réutilisable sans le détruire.
  const stmtCache = new Map<string, ReturnType<SqlJsDatabase['prepare']>>();

  function getCompiledStmt(sql: string): ReturnType<SqlJsDatabase['prepare']> {
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
          const stmt = getCompiledStmt(sql);
          try {
            stmt.bind(params as never);
            if (stmt.step()) {
              return stmt.getAsObject();
            }
            return undefined;
          } finally {
            stmt.reset();
          }
        },
        all(...params: unknown[]) {
          const stmt = getCompiledStmt(sql);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const rows: any[] = [];
          try {
            stmt.bind(params as never);
            while (stmt.step()) {
              rows.push(stmt.getAsObject());
            }
            return rows;
          } finally {
            stmt.reset();
          }
        },
        run(...params: unknown[]) {
          const stmt = getCompiledStmt(sql);
          try {
            stmt.bind(params as never);
            stmt.step();
            const changes = rawDb.getRowsModified();
            let lastInsertRowid = 0;
            const res = rawDb.exec('SELECT last_insert_rowid() AS id');
            if (res.length && res[0].values.length) {
              lastInsertRowid = res[0].values[0][0] as number;
            }
            return { changes, lastInsertRowid };
          } finally {
            stmt.reset();
            schedulePersist();
          }
        },
      };
    },
    exec(sql: string): void {
      rawDb.run(sql);
      schedulePersist();
    },
    pragma(sql: string): void {
      // WAL n'a pas de sens pour une base entièrement en mémoire : seul
      // 'foreign_keys' (utilisé plus bas) a un effet réel ici.
      rawDb.run(`PRAGMA ${sql}`);
    },
  };
}

function columnExists(table: string): (column: string) => boolean {
  return (column: string) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    return cols.some((c) => c.name === column);
  };
}

/**
 * Initialise sql.js, recharge le fichier .db existant s'il y en a un
 * (sql.js lit nativement le format de fichier SQLite standard, donc un
 * fichier créé par better-sqlite3 est compatible tel quel), sinon crée
 * une base neuve. Doit être attendu (await) avant tout import qui
 * utilise `db` — voir src/index.ts.
 */
export async function initDb(filePath: string = config.dbPath): Promise<void> {
  dbFilePath = filePath;
  ensureDirExists(filePath);

  const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
  const SQL = await initSqlJs({ locateFile: () => wasmPath });

  if (fs.existsSync(filePath)) {
    const fileBuffer = fs.readFileSync(filePath);
    raw = new SQL.Database(fileBuffer);
  } else {
    raw = new SQL.Database();
  }

  db = buildShim(raw);
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
  const gamesHasColumn = columnExists('games');
  const answersHasColumn = columnExists('answers');
  if (!gamesHasColumn('phase_count')) {
    db.exec('ALTER TABLE games ADD COLUMN phase_count INTEGER NOT NULL DEFAULT 6');
  }
  if (!answersHasColumn('message_key')) {
    db.exec('ALTER TABLE answers ADD COLUMN message_key TEXT');
  }

  // Toute écriture faite pendant l'initialisation (migrations) doit être
  // sur disque avant que le reste de l'appli ne commence à tourner.
  flushDbToDisk();
}