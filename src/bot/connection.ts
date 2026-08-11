import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  type WASocket,
  type WAMessage,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import { config } from '../config/config';
import { logger } from '../utils/logger';
import { cancelAllActiveGamesOnDisconnect } from '../game/gameManager';
import { handleIncomingMessage } from './commandRouter';

/**
 * Décision produit : en cas de coupure, on n'essaie PAS de faire
 * survivre une partie en cours (state en mémoire perdu de toute façon
 * pour les timers actifs). On annule proprement (gameManager s'en
 * charge), et on laisse Baileys rouvrir une nouvelle connexion pour
 * accepter de nouvelles commandes ensuite.
 */
export async function startBot(): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(config.authFolder);

  const sock: WASocket = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      logger.info('Scanne ce QR code avec WhatsApp pour authentifier le bot :');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      logger.warn('Connexion fermée', { statusCode, shouldReconnect });

      // Annulation propre de toute partie en cours (cf. décision produit).
      void cancelAllActiveGamesOnDisconnect();

      if (shouldReconnect) {
        void startBot();
      } else {
        logger.error('Session déconnectée (logout). Ré-authentification requise (nouveau QR).');
      }
    } else if (connection === 'open') {
      logger.info('Bot connecté à WhatsApp ✅');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    // Traitement CONCURRENT du lot de messages (important quand beaucoup
    // de joueurs répondent quasi simultanément) : chaque réponse est
    // indépendante des autres et sécurisée contre les courses via le
    // marquage mémoire synchrone dans questionRunner.tryHandleAnswer,
    // donc un traitement séquentiel n'apporterait rien et ralentirait
    // inutilement la prise en compte des réponses côté grand groupe.
    await Promise.all(
      messages.map(async (msg: WAMessage) => {
        try {
          await handleIncomingMessage(sock, msg);
        } catch (err) {
          logger.error('Erreur traitement message entrant', { error: String(err) });
        }
      })
    );
  });
}
