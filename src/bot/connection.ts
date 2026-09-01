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
import { restoreSessionIfNeeded, scheduleSessionReupload } from '../utils/megaSession';

/**
 * Décision produit : en cas de coupure, on n'essaie PAS de faire
 * survivre une partie en cours (state en mémoire perdu de toute façon
 * pour les timers actifs). On annule proprement (gameManager s'en
 * charge), et on laisse Baileys rouvrir une nouvelle connexion pour
 * accepter de nouvelles commandes ensuite.
 */
export async function startBot(): Promise<void> {
  await restoreSessionIfNeeded();
  const { state, saveCreds } = await useMultiFileAuthState(config.authFolder);

  // Le logger interne de Baileys était en 'silent' : ça masquait
  // totalement les avertissements de session Signal (ex : échec de
  // déchiffrement d'un message, renégociation de clé) qui sont une
  // cause plausible de messages jamais reçus par le bot, en particulier
  // sous forte charge (plusieurs joueurs qui répondent au même
  // instant). Niveau 'warn' : suffisant pour capter ces événements
  // sans être noyé par le trafic normal (verbeux en 'debug'/'trace').
  const sock: WASocket = makeWASocket({
    auth: state,
    logger: pino({ level: 'warn' }),
    printQRInTerminal: false,
  });

  // Persiste chaque rotation de creds sur disque, PUIS programme un
  // ré-upload (débouncé) vers Mega. Sans ce câblage, seule la session
  // du tout premier pairing est sauvegardée : les rotations de clés
  // qui surviennent en cours de vie normale de la session ne sont
  // jamais persistées, et un redémarrage recharge une session périmée
  // que WhatsApp rejette (nouveau QR requis).
  sock.ev.on('creds.update', async () => {
    await saveCreds();
    scheduleSessionReupload();
  });

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
    // Diagnostic : trace la taille de chaque lot reçu. Sert à corréler
    // les rapports "réponses ignorées surtout quand tout le monde
    // répond en même temps" avec la taille réelle des lots livrés par
    // Baileys (un gros lot n'implique pas forcément un traitement
    // concurrent problématique côté bot — voir le raisonnement détaillé
    // dans questionRunner.tryHandleAnswer — mais aide à confirmer si le
    // volume corrèle avec les pertes observées côté déchiffrement).
    if (messages.length > 1) {
      logger.info(`Lot de ${messages.length} messages reçus simultanément`);
    }
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