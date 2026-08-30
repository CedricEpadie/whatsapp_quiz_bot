import { initDb, flushDbToDisk } from './db/database';
import { config } from './config/config';
import { loadAllThemes } from './questions/questionLoader';
import { setThemesCache } from './game/gameManager';
import { startBot } from './bot/connection';
import { logger } from './utils/logger';
import { startKeepAlive } from './utils/keepAlive';

// sql.js travaille en mémoire : on doit s'assurer que les dernières
// écritures en attente (debounce de 500ms, voir db/database.ts) sont
// bien flushées sur disque avant que le process ne s'arrête.
function registerGracefulShutdown(): void {
  const shutdown = (signal: string) => {
    logger.info(`Signal ${signal} reçu, sauvegarde de la base avant arrêt...`);
    try {
      flushDbToDisk();
    } catch (err) {
      logger.error('Échec de la sauvegarde finale de la base', { error: String(err) });
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

async function main(): Promise<void> {
  await initDb(); // doit être attendu avant tout accès à la base (sql.js s'initialise de façon asynchrone)
  registerGracefulShutdown();

  try {
    const themes = loadAllThemes();
    setThemesCache(themes);
  } catch (err) {
    logger.error(
      `Impossible de charger les thèmes de questions : ${(err as Error).message}`
    );
    logger.error(
      `Le bot va démarrer quand même, mais .quizz échouera tant que ${config.phaseCount} thèmes valides ne sont pas présents dans src/questions/data/themes/.`
    );
    setThemesCache([]);
  }

  startKeepAlive();
  await startBot();
}

main().catch((err) => {
  logger.error('Erreur fatale au démarrage', { error: String(err) });
  process.exit(1);
});
