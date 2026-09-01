import { config } from '../config/config';
import { getPlayerCount, getPlayers, registerPlayer } from '../db/gameRepository';
import { templates } from '../messages/templates';
import { DeadlineTimer } from '../utils/timer';
import { allCandidateJids, type SenderIdentity } from '../utils/jid';
import { logger } from '../utils/logger';
import type { Actions } from '../bot/actions';

export interface RegistrationWindow {
  timer: DeadlineTimer;
  /** Résout avec true si le minimum de joueurs est atteint à l'échéance. */
  result: Promise<boolean>;
  /** À appeler pour couper les rappels périodiques (fin normale ou stop forcé). */
  stopReminders: () => void;
}

/**
 * Ouvre la fenêtre d'inscription de config.registrationDurationMs.
 * Envoie un rappel stylisé toutes les config.registrationReminderIntervalMs
 * (nombre d'inscrits, temps restant, message d'encouragement).
 */
export function openRegistrationWindow(
  gameId: number,
  actions: Actions
): RegistrationWindow {
  const timer = new DeadlineTimer();
  const startedAt = Date.now();

  const reminderHandle = setInterval(() => {
    const elapsed = Date.now() - startedAt;
    const remainingMs = config.registrationDurationMs - elapsed;
    if (remainingMs <= 0) return; // le timer principal va clore d'un instant à l'autre
    const count = getPlayerCount(gameId);
    void actions.send(
      templates.registrationReminder(count, Math.round(remainingMs / 1000))
    );
  }, config.registrationReminderIntervalMs);

  const stopReminders = (): void => clearInterval(reminderHandle);

  const result = new Promise<boolean>((resolve) => {
    timer.start(config.registrationDurationMs, () => {
      stopReminders();
      const count = getPlayerCount(gameId);
      resolve(count >= config.minPlayers);
    });
  });

  return { timer, result, stopReminders };
}

/**
 * Traite un message "Partant" reçu pendant la fenêtre d'inscription.
 * Insensible à la casse, comparaison stricte au mot exact (pas de
 * sous-chaîne) pour éviter les faux positifs sur des phrases contenant
 * "partant" incidemment.
 *
 * `senderIdentity` porte le JID primaire du message ET ses variantes
 * connues (@lid/@s.whatsapp.net, voir utils/jid.ts). Le contrôle
 * "déjà inscrit ?" est fait sur TOUS les candidats : sans ça, un
 * joueur dont Baileys rapporte le JID sous un format différent d'un
 * message à l'autre pourrait se retrouver inscrit deux fois (deux
 * lignes `players` distinctes pour la même personne), ce qui fausse
 * ensuite silencieusement le comptage de joueurs et les classements.
 */
export async function handleRegistrationMessage(
  gameId: number,
  senderIdentity: SenderIdentity,
  displayName: string,
  rawText: string,
  actions: Actions
): Promise<void> {
  const normalized = rawText.trim().toLowerCase();
  if (normalized !== config.registrationKeyword) return;

  const candidates = allCandidateJids(senderIdentity);
  const existing = getPlayers(gameId).find((p) => candidates.includes(p.jid));
  if (existing) {
    if (existing.jid !== senderIdentity.primary) {
      logger.warn('Inscription "Partant" reçue avec un JID alternatif déjà inscrit', {
        gameId,
        knownJid: existing.jid,
        newJid: senderIdentity.primary,
      });
    }
    await actions.send(templates.alreadyRegistered());
    return;
  }

  const player = registerPlayer(gameId, senderIdentity.primary, displayName);
  if (!player) {
    await actions.send(templates.alreadyRegistered());
    return;
  }

  const count = getPlayerCount(gameId);
  await actions.send(templates.playerRegistered(displayName, count));
}