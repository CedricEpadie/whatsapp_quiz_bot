import http from 'http';
import https from 'https';
import { config } from '../config/config';
import { logger } from './logger';

const PORT = Number(process.env.PORT ?? 8080);
const PING_INTERVAL_MS = 14 * 60 * 1000; // 14 minutes

/**
 * Démarre un petit serveur HTTP (nécessaire pour que Koyeb considère le
 * service comme actif) et s'auto-ping périodiquement.
 *
 * ATTENTION - ce mécanisme NE prévient PAS la mise en veille "scale to
 * zero" sur Koyeb (ni sur la plupart des hébergeurs de bots équivalents) :
 * ces plateformes ne surveillent que le trafic ENTRANT DEPUIS INTERNET
 * vers le service. Un ping vers 127.0.0.1 ne quitte jamais la machine et
 * n'est donc jamais vu par la couche réseau qui décide de la mise en
 * veille. Si PUBLIC_URL est configuré, on ping cette URL publique à la
 * place (le paquet fait un aller-retour réel par Internet, donc il
 * compte) ; sinon on retombe sur 127.0.0.1, qui garde son utilité en
 * local mais ne résout PAS le problème de mise en veille en production.
 *
 * Même avec PUBLIC_URL configuré, ce timer interne ne peut pas RÉVEILLER
 * le service s'il a déjà été mis en veille (le process est alors arrêté,
 * plus rien ne tourne pour déclencher le ping suivant) : il ne fait que
 * repousser la mise en veille tant que le process est vivant. Pour une
 * garantie plus solide, ajoutez un moniteur externe (UptimeRobot,
 * cron-job.org, etc.) qui appelle PUBLIC_URL toutes les 30-50 minutes :
 * lui seul peut re-déclencher un cold start après une mise en veille.
 */
export function startKeepAlive(): void {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot WhatsApp Quizz en ligne ✅');
  });

  server.listen(PORT, () => {
    logger.info(`Serveur keep-alive démarré sur le port ${PORT}`);
  });

  if (!config.publicUrl) {
    logger.warn(
      "PUBLIC_URL n'est pas configuré : le ping keep-alive reste en local (127.0.0.1) " +
        "et ne préviendra probablement pas la mise en veille de l'hébergeur en production."
    );
  }

  setInterval(() => {
    if (config.publicUrl) {
      const client = config.publicUrl.startsWith('https') ? https : http;
      client
        .get(config.publicUrl, (res) => {
          res.resume();
          logger.info('Ping keep-alive externe envoyé', { status: res.statusCode });
        })
        .on('error', (err) => {
          logger.warn('Échec du ping keep-alive externe', { error: String(err) });
        });
      return;
    }

    http
      .get(`http://127.0.0.1:${PORT}/`, (res) => {
        res.resume(); // consomme la réponse sans rien en faire
        logger.info('Ping keep-alive local envoyé', { status: res.statusCode });
      })
      .on('error', (err) => {
        logger.warn('Échec du ping keep-alive local', { error: String(err) });
      });
  }, PING_INTERVAL_MS);
}