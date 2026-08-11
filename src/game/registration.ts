import { config } from '../config/config';
import { getPlayerCount, getPlayers, registerPlayer } from '../db/gameRepository';
import { templates } from '../messages/templates';
import { DeadlineTimer } from '../utils/timer';
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
 */
export async function handleRegistrationMessage(
  gameId: number,
  jid: string,
  displayName: string,
  rawText: string,
  actions: Actions
): Promise<void> {
  const normalized = rawText.trim().toLowerCase();
  if (normalized !== config.registrationKeyword) return;

  const existing = getPlayers(gameId).find((p) => p.jid === jid);
  if (existing) {
    await actions.send(templates.alreadyRegistered());
    return;
  }

  const player = registerPlayer(gameId, jid, displayName);
  if (!player) {
    await actions.send(templates.alreadyRegistered());
    return;
  }

  const count = getPlayerCount(gameId);
  await actions.send(templates.playerRegistered(displayName, count));
}
