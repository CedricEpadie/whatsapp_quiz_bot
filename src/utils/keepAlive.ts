import http from 'http';
import { logger } from './logger';

const PORT = Number(process.env.PORT ?? 8080);
const PING_INTERVAL_MS = 14 * 60 * 1000; // 14 minutes

/**
 * Démarre un petit serveur HTTP (nécessaire pour que Koyeb considère
 * le service comme actif) et s'auto-appelle toutes les 14 minutes pour
 * empêcher la mise en veille. Fonctionne aussi en local : le serveur
 * démarre juste sur le port choisi, sans aucun effet sur le bot.
 */
export function startKeepAlive(): void {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot WhatsApp Quizz en ligne ✅');
  });

  server.listen(PORT, () => {
    logger.info(`Serveur keep-alive démarré sur le port ${PORT}`);
  });

  setInterval(() => {
    http
      .get(`http://127.0.0.1:${PORT}/`, (res) => {
        res.resume(); // consomme la réponse sans rien en faire
        logger.info('Ping keep-alive envoyé', { status: res.statusCode });
      })
      .on('error', (err) => {
        logger.warn('Échec du ping keep-alive', { error: String(err) });
      });
  }, PING_INTERVAL_MS);
}