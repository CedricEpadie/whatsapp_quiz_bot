import type { WASocket, WAMessage } from '@whiskeysockets/baileys';
import { config } from '../config/config';
import { templates } from '../messages/templates';
import { startQuizz, stopQuizz, forceResetGame, routeGroupMessage, isQuestionLiveInGroup } from '../game/gameManager';
import { logger } from '../utils/logger';
import { Semaphore } from '../utils/semaphore';
import { resolveSenderJids } from '../utils/jid';
import type { Actions, SentMessage } from './actions';

/**
 * IDs des messages TEXTE envoyés par le bot lui-même, pour les
 * distinguer des messages envoyés par le propriétaire depuis son
 * propre téléphone.
 *
 * Pourquoi c'est nécessaire : si le bot est lié en tant qu'appareil
 * compagnon du MÊME compte WhatsApp que celui utilisé pour taper les
 * commandes (cas très courant en test/dev), Baileys marque aussi bien
 * les messages envoyés par le bot QUE ceux tapés depuis le téléphone
 * principal du propriétaire comme `fromMe: true`. On ne filtre donc que
 * nos propres échos, identifiés par l'ID exact du message envoyé — pas
 * tout `fromMe`. Seuls les envois de texte (`send`) ont besoin de ce
 * suivi : les réactions/éditions ne repassent pas par messages.upsert
 * de la même façon et ne peuvent pas être confondues avec une commande.
 */
const sentMessageIds = new Set<string>();
const SENT_ID_TTL_MS = 60_000;

/**
 * IDs des messages ENTRANTS déjà traités, tous types confondus (commande
 * ou réponse de joueur), pour ne jamais exécuter deux fois la même
 * action derrière un même message.
 *
 * Pourquoi c'est nécessaire : WhatsApp peut redistribuer un message déjà
 * livré (rattrapage "hors ligne" après une reconnexion, en particulier
 * quand la synchronisation d'état de Baileys est cassée — voir les logs
 * "failed to sync state from version" observés en production). Sans ce
 * filet, une commande ".quizz" tapée une seule fois peut être exécutée
 * deux fois si WhatsApp la re-livre, ce qui déclenche à tort "une partie
 * est déjà en cours" juste après le lancement — y compris dans un groupe
 * qui n'a jamais vu le bot auparavant, puisque ce n'est pas un problème
 * d'état stocké par groupe mais de LIVRAISON DUPLIQUÉE du même message.
 * Clé = remoteJid + id (l'ID seul n'est unique que par conversation).
 */
const processedIncomingIds = new Set<string>();
const PROCESSED_INCOMING_TTL_MS = 5 * 60_000;

function markProcessed(msg: WAMessage): boolean {
  const id = msg.key.id;
  const remoteJid = msg.key.remoteJid;
  if (!id || !remoteJid) return true; // pas assez d'info pour dédupliquer, on laisse passer
  const dedupeKey = `${remoteJid}:${id}`;
  if (processedIncomingIds.has(dedupeKey)) {
    logger.warn('Message entrant déjà traité, ignoré (probable re-livraison WhatsApp)', {
      remoteJid,
      id,
    });
    return false;
  }
  processedIncomingIds.add(dedupeKey);
  setTimeout(() => processedIncomingIds.delete(dedupeKey), PROCESSED_INCOMING_TTL_MS);
  return true;
}

/**
 * Toutes les requêtes sortantes vers WhatsApp (envoi, édition,
 * réaction) passent par ce sémaphore partagé, pour éviter d'envoyer
 * une rafale de dizaines d'appels simultanés quand beaucoup de joueurs
 * répondent en même temps — voir utils/semaphore.ts.
 */
const whatsAppCallLimiter = new Semaphore(config.maxConcurrentWhatsAppCalls);

function extractText(msg: WAMessage): string {
  const m = msg.message;
  if (!m) return '';
  return (
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    ''
  );
}

function isGroupMessage(msg: WAMessage): boolean {
  return Boolean(msg.key.remoteJid?.endsWith('@g.us'));
}

function getSenderDisplayName(msg: WAMessage, primaryJid: string): string {
  return msg.pushName?.trim() || primaryJid.split('@')[0];
}

function makeActions(sock: WASocket, groupId: string): Actions {
  return {
    async send(text, mentions) {
      return whatsAppCallLimiter.run(async () => {
        const result = await sock.sendMessage(groupId, { text, mentions });
        const id = result?.key?.id;
        if (id) {
          sentMessageIds.add(id);
          setTimeout(() => sentMessageIds.delete(id), SENT_ID_TTL_MS);
        }
        return { key: result?.key } as SentMessage;
      });
    },
    async edit(key, text) {
      await whatsAppCallLimiter.run(() => sock.sendMessage(groupId, { text, edit: key }));
    },
    async react(key, emoji) {
      await whatsAppCallLimiter.run(() => sock.sendMessage(groupId, { react: { text: emoji, key } }));
    },
  };
}

/** Parse ".quizz", ".quizz rules", ".quizz stop", ".quizz reset" ou ".quizz <nombre de phases>". */
function parseQuizzCommand(
  text: string
): { kind: 'start'; phaseCount?: number } | { kind: 'rules' } | { kind: 'stop' } | { kind: 'reset' } | null {
  const parts = text.trim().split(/\s+/);
  if (parts[0]?.toLowerCase() !== '.quizz') return null;

  const arg = parts[1]?.toLowerCase();
  if (!arg) return { kind: 'start' };
  if (arg === 'rules') return { kind: 'rules' };
  if (arg === 'stop') return { kind: 'stop' };
  if (arg === 'reset') return { kind: 'reset' };

  const n = Number(arg);
  return { kind: 'start', phaseCount: Number.isFinite(n) ? n : Number.NaN };
}

export async function handleIncomingMessage(sock: WASocket, msg: WAMessage): Promise<void> {
  const msgId = msg.key.id;
  if (msgId && sentMessageIds.has(msgId)) return; // écho d'un de nos propres envois
  if (!markProcessed(msg)) return; // déjà traité (re-livraison WhatsApp) — voir markProcessed

  // Diagnostic : un message que Baileys n'a pas réussi à déchiffrer
  // ("No session found to decrypt message", voir logs internes en
  // bot/connection.ts) arrive quand même jusqu'ici, mais VIDÉ de son
  // contenu (messageStubType = CIPHERTEXT) — extractText() ci-dessous
  // retournerait juste '' silencieusement. On le trace explicitement
  // ici, avec le contexte "une question est-elle active dans ce groupe
  // en ce moment ?", pour distinguer une perte sans conséquence d'une
  // perte qui a effectivement coûté une réponse à un joueur.
  if (msg.messageStubType === 2 /* proto.WebMessageInfo.StubType.CIPHERTEXT */) {
    const groupId = msg.key.remoteJid ?? '';
    logger.warn('Message reçu mais illisible (échec de déchiffrement en amont)', {
      groupId,
      participant: msg.key.participant,
      questionActiveDansCeGroupe: isQuestionLiveInGroup(groupId),
    });
    return;
  }

  const text = extractText(msg).trim();
  if (!text) return;

  const groupId = msg.key.remoteJid ?? '';
  const senderIdentity = resolveSenderJids(msg);
  const senderJid = senderIdentity.primary;
  const senderName = getSenderDisplayName(msg, senderJid);

  const command = parseQuizzCommand(text);

  if (command && !isGroupMessage(msg)) {
    await sock.sendMessage(groupId, { text: templates.invalidContext() });
    return;
  }

  if (!isGroupMessage(msg)) return; // le reste du bot n'agit qu'en groupe

  const actions = makeActions(sock, groupId);

  if (command?.kind === 'rules') {
    await actions.send(templates.rules());
    return;
  }

  const isLinkedAccount = Boolean(msg.key.fromMe);
  const allowed = config.commandAccessMode === 'everyone' || isLinkedAccount;

  if (command?.kind === 'stop') {
    if (!allowed) {
      await actions.send(templates.notAllowed());
      return;
    }
    await stopQuizz(groupId, actions);
    return;
  }

  if (command?.kind === 'reset') {
    // Filet de secours manuel — admin uniquement (comme "stop"), voir
    // gameManager.forceResetGame pour le contexte détaillé. Utile en
    // attendant un correctif définitif si ".quizz" répond à tort "une
    // partie est déjà en cours" sans qu'aucune partie ne tourne
    // réellement (ligne fantôme en base, ou commande traitée en double
    // suite à une re-livraison WhatsApp).
    if (!allowed) {
      await actions.send(templates.notAllowed());
      return;
    }
    await forceResetGame(groupId, actions);
    return;
  }

  if (command?.kind === 'start') {
    if (!allowed) {
      await actions.send(templates.notAllowed());
      logger.warn('Tentative de lancement refusée (mode "linkedAccount")', { senderJid });
      return;
    }
    if (command.phaseCount !== undefined && Number.isNaN(command.phaseCount)) {
      await actions.send(templates.invalidPhaseCount(1, 99));
      return;
    }
    void startQuizz(groupId, actions, command.phaseCount); // fire-and-forget
    return;
  }

  // Tout le reste (inscription "Partant", réponses A/B/C/D) est routé
  // vers le gestionnaire de partie, qui décide s'il y a quelque chose à
  // en faire selon l'état courant. `senderIdentity` porte aussi bien le
  // JID "primaire" que ses éventuelles variantes @lid/@s.whatsapp.net
  // connues pour ce message (voir utils/jid.ts) : la partie a besoin
  // des deux pour retrouver un joueur inscrit sous un format différent.
  await routeGroupMessage(groupId, senderIdentity, senderName, text, msg.key);
}
