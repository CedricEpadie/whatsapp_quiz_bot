import './db/database'; // initialise le schéma SQLite au chargement
import { config } from './config/config';
import { loadAllThemes } from './questions/questionLoader';
import { setThemesCache } from './game/gameManager';
import { startBot } from './bot/connection';
import { logger } from './utils/logger';
import { startKeepAlive } from './utils/keepAlive';

async function main(): Promise<void> {
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
