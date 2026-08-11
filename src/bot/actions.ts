import type { WAMessageKey } from '@whiskeysockets/baileys';

export interface SentMessage {
  key: WAMessageKey;
}

/**
 * Toutes les interactions du bot vers WhatsApp passent par cette
 * interface, injectée dans le moteur de jeu (game/*). Ça isole
 * complètement la logique de jeu du détail de l'API Baileys.
 */
export interface Actions {
  /** Envoie un message texte, éventuellement avec des mentions (@joueur). */
  send: (text: string, mentions?: string[]) => Promise<SentMessage>;
  /** Édite un message déjà envoyé par le bot (utilisé pour le décompte). */
  edit: (key: WAMessageKey, text: string) => Promise<void>;
  /** Réagit à un message (utilisé pour ✅/❌ sur les réponses des joueurs). */
  react: (key: WAMessageKey, emoji: string) => Promise<void>;
}

/** Formate un JID en mention WhatsApp affichable dans un texte ("@33612345678"). */
export function mentionOf(jid: string): string {
  return `@${jid.split('@')[0]}`;
}
