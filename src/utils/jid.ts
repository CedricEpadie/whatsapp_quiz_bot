import type { WAMessage } from '@whiskeysockets/baileys';

/**
 * WhatsApp identifie un participant de groupe soit par son "PN"
 * (numéro de téléphone, `xxxxx@s.whatsapp.net`), soit par son "LID"
 * (identifiant masqué, `xxxxx@lid`) — et Baileys ne garantit PAS que
 * `msg.key.participant` porte toujours le même format d'un message à
 * l'autre pour une même personne. Un joueur peut donc apparaître sous
 * un JID à l'inscription ("Partant") et sous un JID différent au
 * moment de répondre à une question.
 *
 * Heureusement, Baileys expose sur `WAMessageKey` les champs "miroir"
 * (`participantLid` / `participantPn`) qui donnent l'AUTRE identité de
 * la même personne quand il a pu la résoudre. `resolveSenderJids`
 * retourne l'ensemble des JID candidats pour un message donné, afin
 * que la logique de jeu puisse retrouver un joueur inscrit même si le
 * format a changé entre deux messages.
 *
 * Voir : https://github.com/WhiskeySockets/Baileys (issues #1718, #2263,
 * #2414) pour le contexte plus large de ce comportement WhatsApp.
 */
export interface SenderIdentity {
  /** JID "primaire" tel qu'observé sur ce message (participant, ou remoteJid en DM). */
  primary: string;
  /** Autre(s) JID connu(s) pour la même personne sur ce message, si Baileys a pu les résoudre. */
  alternates: string[];
}

export function resolveSenderJids(msg: WAMessage): SenderIdentity {
  const key = msg.key;
  const primary = key.participant ?? key.remoteJid ?? '';

  const candidates = [key.participantLid, key.participantPn, key.senderLid, key.senderPn].filter(
    (v): v is string => Boolean(v) && v !== primary
  );

  // Déduplique tout en préservant l'ordre.
  const alternates = [...new Set(candidates)];

  return { primary, alternates };
}

/** Tous les JID candidats (primaire + alternatifs), dans l'ordre de priorité. */
export function allCandidateJids(identity: SenderIdentity): string[] {
  return [identity.primary, ...identity.alternates];
}
