import { initDb, flushDbToDisk } from './db/database';
import { pruneOldGames, cancelStaleActiveGames } from './db/gameRepository';
import { config } from './config/config';
import { loadAllThemes } from './questions/questionLoader';
import { setThemesCache, cancelAllActiveGamesOnDisconnect } from './game/gameManager';
import { startBot } from './bot/connection';
import { logger } from './utils/logger';
import { startKeepAlive } from './utils/keepAlive';

const PRUNE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000; // vérifie une fois par jour

/**
 * Purge les vieilles parties terminées/annulées pour empêcher le fichier
 * .db de grossir indéfiniment (voir gameRepository.pruneOldGames).
 */
function pruneOldGamesSafely(): void {
  try {
    const deleted = pruneOldGames(PRUNE_MAX_AGE_MS);
    if (deleted > 0) {
      logger.info(`Purge : ${deleted} ancienne(s) partie(s) supprimée(s) de la base`);
    }
  } catch (err) {
    logger.error('Échec de la purge des anciennes parties', { error: String(err) });
  }
}

// node:sqlite écrit directement sur disque à chaque requête (voir
// db/database.ts) : flushDbToDisk() n'est plus qu'un no-op conservé pour
// compat. Ce qui reste réellement nécessaire ici, c'est de marquer toute
// partie en mémoire ('registration'/'running') comme annulée AVANT de
// quitter : sans ça, un redémarrage volontaire (redéploiement) pendant
// une partie active laisse une ligne bloquée en base, et `.quizz` refuse
// ensuite de démarrer dans ce groupe en disant
// "une partie est déjà en cours" — alors qu'il n'y en a plus aucune
// (voir aussi cancelStaleActiveGames, filet de sécurité complémentaire
// pour le cas d'un arrêt NON propre, ex. crash/kill, appelé au
// démarrage).
function registerGracefulShutdown(): void {
  const shutdown = (signal: string) => {
    logger.info(`Signal ${signal} reçu, sauvegarde de la base avant arrêt...`);
    cancelAllActiveGamesOnDisconnect()
      .catch((err) => logger.error("Échec de l'annulation des parties en cours", { error: String(err) }))
      .finally(() => {
        try {
          flushDbToDisk();
        } catch (err) {
          logger.error('Échec de la sauvegarde finale de la base', { error: String(err) });
        }
        process.exit(0);
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

async function main(): Promise<void> {
  await initDb(); // doit être attendu avant tout accès à la base (ouverture du fichier)
  registerGracefulShutdown();

  // Filet de sécurité pour un arrêt NON propre du process précédent
  // (crash, kill -9, coupure d'alimentation, panel d'hébergement qui
  // redémarre le service) : registerGracefulShutdown() ne peut rien
  // faire dans ce cas puisqu'aucun signal n'est reçu. Un process qui
  // démarre repart TOUJOURS avec un état mémoire vide (game/gameManager
  // .runtimeGames), donc toute ligne encore 'registration'/'running' en
  // base à ce stade est nécessairement une partie fantôme d'un process
  // précédent — jamais une partie réellement en cours de celui-ci.
  const staleCount = cancelStaleActiveGames();
  if (staleCount > 0) {
    logger.warn(
      `${staleCount} partie(s) fantôme(s) d'un précédent démarrage annulée(s) (arrêt non propre du process précédent)`
    );
  }

  pruneOldGamesSafely();
  setInterval(pruneOldGamesSafely, PRUNE_INTERVAL_MS);

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