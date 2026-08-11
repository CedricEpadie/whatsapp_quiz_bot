import type { WASocket, WAMessage } from '@whiskeysockets/baileys';
import { config } from '../config/config';
import { templates } from '../messages/templates';
import { startQuizz, stopQuizz, routeGroupMessage } from '../game/gameManager';
import { logger } from '../utils/logger';
import { Semaphore } from '../utils/semaphore';
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

function getSenderJid(msg: WAMessage): string {
  return msg.key.participant ?? msg.key.remoteJid ?? '';
}

function getSenderDisplayName(msg: WAMessage): string {
  return msg.pushName?.trim() || getSenderJid(msg).split('@')[0];
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

/** Parse ".quizz", ".quizz rules", ".quizz stop" ou ".quizz <nombre de phases>". */
function parseQuizzCommand(
  text: string
): { kind: 'start'; phaseCount?: number } | { kind: 'rules' } | { kind: 'stop' } | null {
  const parts = text.trim().split(/\s+/);
  if (parts[0]?.toLowerCase() !== '.quizz') return null;

  const arg = parts[1]?.toLowerCase();
  if (!arg) return { kind: 'start' };
  if (arg === 'rules') return { kind: 'rules' };
  if (arg === 'stop') return { kind: 'stop' };

  const n = Number(arg);
  return { kind: 'start', phaseCount: Number.isFinite(n) ? n : Number.NaN };
}

export async function handleIncomingMessage(sock: WASocket, msg: WAMessage): Promise<void> {
  const msgId = msg.key.id;
  if (msgId && sentMessageIds.has(msgId)) return; // écho d'un de nos propres envois

  const text = extractText(msg).trim();
  if (!text) return;

  const groupId = msg.key.remoteJid ?? '';
  const senderJid = getSenderJid(msg);
  const senderName = getSenderDisplayName(msg);

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
  // en faire selon l'état courant.
  await routeGroupMessage(groupId, senderJid, senderName, text, msg.key);
}
