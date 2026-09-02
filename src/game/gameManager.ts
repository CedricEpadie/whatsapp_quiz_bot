import { config } from '../config/config';
import {
  createGame,
  getActiveGame,
  getPlayers,
  setGameProgress,
  setGameStatus,
  type PlayerRow,
} from '../db/gameRepository';
import { templates } from '../messages/templates';
import { pickThemesForGame, pickQuestionsForPhase } from '../questions/questionLoader';
import { openRegistrationWindow, handleRegistrationMessage, type RegistrationWindow } from './registration';
import { startQuestion, tryHandleAnswer, type RunQuestionResult } from './questionRunner';
import { applyPerfectPhaseBonus, determineWinners, getCurrentScoreboard } from './scoring';
import { logger } from '../utils/logger';
import { extractAnswerChoice } from '../utils/answerParser';
import type { LiveQuestionState, ThemeFile } from './types';
import type { Actions } from '../bot/actions';
import type { WAMessageKey } from '@whiskeysockets/baileys';
import type { SenderIdentity } from '../utils/jid';

type RuntimePhase = 'registration' | 'running' | 'idle';

interface RuntimeGame {
  gameId: number;
  groupId: string;
  actions: Actions;
  phase: RuntimePhase;
  phaseCount: number;
  playersByJid: Map<string, PlayerRow>;
  playersById: Map<number, PlayerRow>;
  liveQuestion: LiveQuestionState | null;
  cancelled: boolean;

  // Points d'interruption pour un arrêt propre (.quizz stop) : chacun
  // permet de débloquer immédiatement l'await en cours dans startQuizz.
  registrationWindow: RegistrationWindow | null;
  activeQuestion: RunQuestionResult | null;
  cancelSleep: (() => void) | null;
}

/** Une entrée par groupe ayant une partie active (registration ou running). */
const runtimeGames = new Map<string, RuntimeGame>();

/**
 * Retrouve un joueur inscrit à partir de tous ses JID candidats
 * (primaire + variantes @lid/@s.whatsapp.net connues sur ce message
 * précis — voir utils/jid.ts). WhatsApp ne garantit pas que Baileys
 * rapporte toujours le même format de JID pour une même personne d'un
 * message à l'autre ; un joueur inscrit sous un format peut donc
 * répondre sous l'autre. Sans ce filet, `playersByJid.get(jid)` rate
 * silencieusement et la réponse est ignorée comme si le joueur n'était
 * pas inscrit (bug observé : réponses ignorées de façon intermittente,
 * surtout quand plusieurs joueurs répondent au même moment).
 *
 * Si le joueur est retrouvé via une variante (pas le JID primaire), la
 * map est mise à jour pour indexer aussi cette variante (auto-
 * guérison : les prochains messages sous ce format seront trouvés en
 * O(1) direct) et l'événement est loggé pour pouvoir confirmer/mesurer
 * la fréquence du phénomène en production.
 */
function resolvePlayerByIdentity(
  playersByJid: Map<string, PlayerRow>,
  identity: SenderIdentity,
  context: string
): PlayerRow | undefined {
  const direct = playersByJid.get(identity.primary);
  if (direct) return direct;

  for (const altJid of identity.alternates) {
    const viaAlt = playersByJid.get(altJid);
    if (viaAlt) {
      playersByJid.set(identity.primary, viaAlt); // auto-guérison pour les prochains messages
      logger.warn('Joueur retrouvé via un JID alternatif (@lid/@s.whatsapp.net)', {
        context,
        primaryJid: identity.primary,
        matchedAltJid: altJid,
        playerId: viaAlt.id,
      });
      return viaAlt;
    }
  }

  return undefined;
}

let allThemesCache: ThemeFile[] = [];

export function setThemesCache(themes: ThemeFile[]): void {
  allThemesCache = themes;
}

export function hasActiveGame(groupId: string): boolean {
  return runtimeGames.has(groupId) || Boolean(getActiveGame(groupId));
}

/**
 * Diagnostic uniquement : indique si une question est actuellement en
 * attente de réponses dans ce groupe. Utilisé par commandRouter pour
 * savoir si un message perdu à cause d'un échec de déchiffrement
 * ("No session found to decrypt message", voir bot/connection.ts) est
 * tombé pendant la fenêtre de réponse (perte potentiellement décisive
 * pour le joueur) ou en dehors (sans conséquence sur le jeu).
 */
export function isQuestionLiveInGroup(groupId: string): boolean {
  return Boolean(runtimeGames.get(groupId)?.liveQuestion);
}

/** Sommeil interruptible par .quizz stop (voir RuntimeGame.cancelSleep). */
function cancellableSleep(runtime: RuntimeGame, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      runtime.cancelSleep = null;
      resolve();
    }, ms);
    runtime.cancelSleep = () => {
      clearTimeout(t);
      runtime.cancelSleep = null;
      resolve();
    };
  });
}

/**
 * Valide le nombre de phases demandé pour une partie. Sans argument,
 * on prend le plus petit entre la valeur par défaut et le nombre de
 * thèmes disponibles (pour ne jamais bloquer un démarrage simple).
 */
function resolvePhaseCount(
  requested: number | undefined
): { ok: true; phaseCount: number } | { ok: false; message: string } {
  const maxAvailable = allThemesCache.length;
  if (maxAvailable === 0) {
    return { ok: false, message: templates.noThemesAvailable() };
  }
  if (requested === undefined) {
    return { ok: true, phaseCount: Math.min(config.phaseCount, maxAvailable) };
  }
  if (!Number.isInteger(requested) || requested < 1 || requested > maxAvailable) {
    return { ok: false, message: templates.invalidPhaseCount(1, maxAvailable) };
  }
  return { ok: true, phaseCount: requested };
}

/**
 * Point d'entrée de la commande .quizz. Crée la partie en base, ouvre
 * l'inscription, puis (si assez de joueurs) enchaîne automatiquement
 * toutes les phases jusqu'au classement final. Fire-and-forget du point
 * de vue de l'appelant : gère elle-même tout le cycle de vie.
 */
export async function startQuizz(
  groupId: string,
  actions: Actions,
  requestedPhaseCount?: number
): Promise<void> {
  if (hasActiveGame(groupId)) {
    await actions.send(templates.gameAlreadyRunning());
    return;
  }

  const resolved = resolvePhaseCount(requestedPhaseCount);
  if (!resolved.ok) {
    await actions.send(resolved.message);
    return;
  }
  const { phaseCount } = resolved;

  const gameRow = createGame(groupId, phaseCount);
  const runtime: RuntimeGame = {
    gameId: gameRow.id,
    groupId,
    actions,
    phase: 'registration',
    phaseCount,
    playersByJid: new Map(),
    playersById: new Map(),
    liveQuestion: null,
    cancelled: false,
    registrationWindow: null,
    activeQuestion: null,
    cancelSleep: null,
  };
  runtimeGames.set(groupId, runtime);

  try {
    await actions.send(templates.registrationOpen(config.registrationDurationMs / 1000));

    const registrationWindow = openRegistrationWindow(gameRow.id, actions);
    runtime.registrationWindow = registrationWindow;
    const enoughPlayers = await registrationWindow.result;
    runtime.registrationWindow = null;

    if (runtime.cancelled) return; // .quizz stop ou coupure pendant l'inscription

    if (!enoughPlayers) {
      const players = getPlayers(gameRow.id);
      setGameStatus(gameRow.id, 'cancelled');
      await actions.send(templates.registrationCancelledNotEnough(players.length));
      return;
    }

    const players = getPlayers(gameRow.id);
    for (const p of players) {
      runtime.playersByJid.set(p.jid, p);
      runtime.playersById.set(p.id, p);
    }
    const closedMsg = templates.buildRegistrationClosed(
      players.map((p) => p.jid),
      players.map((p) => p.display_name)
    );
    await actions.send(closedMsg.text, closedMsg.mentions);
    await cancellableSleep(runtime, config.registrationClosedPauseMs);
    if (runtime.cancelled) return;

    await actions.send(templates.preGameRulesReminder(phaseCount, config.questionsPerPhase));
    await cancellableSleep(runtime, config.rulesReadPauseMs);
    if (runtime.cancelled) return;

    runtime.phase = 'running';
    setGameStatus(gameRow.id, 'running');
    await runGamePhases(runtime);
  } catch (err) {
    logger.error('Erreur pendant la partie', { groupId, error: String(err) });
    if (!runtime.cancelled) {
      setGameStatus(gameRow.id, 'cancelled');
      await actions.send(templates.internalError()).catch(() => undefined);
    }
  } finally {
    runtimeGames.delete(groupId);
  }
}

async function runGamePhases(runtime: RuntimeGame): Promise<void> {
  const themes = pickThemesForGame(allThemesCache, runtime.phaseCount);

  for (let phaseIdx = 0; phaseIdx < runtime.phaseCount; phaseIdx++) {
    if (runtime.cancelled) return;
    const theme = themes[phaseIdx];
    const phaseQuestions = pickQuestionsForPhase(theme);

    await runtime.actions.send(
      templates.phaseAnnounce(phaseIdx + 1, runtime.phaseCount, theme.theme)
    );
    if (runtime.cancelled) return;
    await cancellableSleep(runtime, config.phaseAnnouncePauseMs);
    if (runtime.cancelled) return;

    for (let qIdx = 0; qIdx < config.questionsPerPhase; qIdx++) {
      if (runtime.cancelled) return;
      setGameProgress(runtime.gameId, phaseIdx, qIdx);

      if (qIdx > 0) {
        await runtime.actions.send(templates.nextQuestion());
        await cancellableSleep(runtime, config.nextQuestionAnnounceMs);
        if (runtime.cancelled) return;
      }

      const question = phaseQuestions[qIdx];
      const runResult = startQuestion(
        runtime.gameId,
        phaseIdx,
        qIdx,
        question,
        runtime.playersById,
        runtime.actions
      );
      runtime.liveQuestion = runResult.live;
      runtime.activeQuestion = runResult;

      await runResult.waitForReveal;
      runtime.liveQuestion = null;
      runtime.activeQuestion = null;

      if (runtime.cancelled) return;
      if (qIdx < config.questionsPerPhase - 1) {
        await cancellableSleep(runtime, config.revealPauseMs);
        if (runtime.cancelled) return;
      }
    }

    if (runtime.cancelled) return;

    const { perfectPlayerIds } = applyPerfectPhaseBonus(runtime.gameId, phaseIdx);
    const perfect = perfectPlayerIds
      .map((id) => runtime.playersById.get(id))
      .filter((p): p is PlayerRow => Boolean(p))
      .map((p) => ({ jid: p.jid, name: p.display_name }));

    const scoreboard = getCurrentScoreboard(runtime.gameId);
    const summary = templates.phaseSummary(phaseIdx + 1, scoreboard, perfect);
    await runtime.actions.send(summary.text, summary.mentions);
    await cancellableSleep(runtime, config.phaseSummaryPauseMs);
    if (runtime.cancelled) return;

    if (phaseIdx < runtime.phaseCount - 1) {
      await runtime.actions.send(templates.interPhaseBreak());
      await cancellableSleep(runtime, config.interPhaseBreakMs);
      if (runtime.cancelled) return;
    }
  }

  if (runtime.cancelled) return;

  const finalScoreboard = getCurrentScoreboard(runtime.gameId);
  const winners = determineWinners(finalScoreboard);
  setGameStatus(runtime.gameId, 'finished');
  const finalMsg = templates.finalResults(finalScoreboard, winners);
  await runtime.actions.send(finalMsg.text, finalMsg.mentions);
}

/**
 * Arrête une partie en cours dans un groupe donné. Débloque tous les
 * points d'attente possibles (inscription, question active, pauses)
 * pour que la coroutine startQuizz se termine immédiatement plutôt que
 * d'attendre son prochain point de contrôle naturel.
 */
export async function stopQuizz(groupId: string, actions: Actions): Promise<boolean> {
  const runtime = runtimeGames.get(groupId);
  if (!runtime) {
    await actions.send(templates.noActiveGameToStop());
    return false;
  }

  runtime.cancelled = true;
  runtime.registrationWindow?.timer.cancel();
  runtime.registrationWindow?.stopReminders();
  runtime.activeQuestion?.cancel();
  runtime.cancelSleep?.();

  setGameStatus(runtime.gameId, 'cancelled');
  runtimeGames.delete(groupId);
  await actions.send(templates.gameStopped());
  return true;
}

/**
 * Route un message entrant vers la bonne logique : inscription si la
 * partie est en phase d'inscription, réponse à une question si une
 * question est active. Ignoré silencieusement dans tous les autres cas.
 */
export async function routeGroupMessage(
  groupId: string,
  senderIdentity: SenderIdentity,
  displayName: string,
  text: string,
  messageKey: WAMessageKey
): Promise<void> {
  const runtime = runtimeGames.get(groupId);
  if (!runtime || runtime.cancelled) return;

  if (runtime.phase === 'registration') {
    await handleRegistrationMessage(runtime.gameId, senderIdentity, displayName, text, runtime.actions);
    return;
  }

  if (runtime.phase === 'running' && runtime.liveQuestion) {
    const player = resolvePlayerByIdentity(runtime.playersByJid, senderIdentity, 'question_answer');

    if (!player) {
      // Pas de correspondance, même en tenant compte des variantes de
      // JID connues sur ce message. Loggé uniquement quand le texte
      // ressemble à une tentative de réponse (A/B/C/D ou formulation
      // reconnue), pour ne pas noyer les logs avec le bavardage normal
      // du groupe. Utile pour distinguer ce cas (joueur non retrouvé)
      // d'une perte en amont (message jamais reçu par Baileys, ex :
      // échec de déchiffrement sous forte charge).
      if (extractAnswerChoice(text)) {
        logger.warn('Réponse potentielle ignorée : aucun joueur inscrit ne correspond', {
          groupId,
          primaryJid: senderIdentity.primary,
          alternateJids: senderIdentity.alternates,
        });
      }
      return;
    }

    tryHandleAnswer(
      runtime.liveQuestion,
      runtime.gameId,
      player,
      text,
      messageKey,
      runtime.actions
    );
  }
}

/**
 * Annule proprement toute partie active suite à une coupure de
 * connexion détectée par bot/connection.ts. Décision produit : pas de
 * reprise, on informe le(s) groupe(s) concerné(s) et on nettoie l'état.
 */
export async function cancelAllActiveGamesOnDisconnect(): Promise<void> {
  for (const [groupId, runtime] of runtimeGames.entries()) {
    runtime.cancelled = true;
    runtime.registrationWindow?.timer.cancel();
    runtime.registrationWindow?.stopReminders();
    runtime.activeQuestion?.cancel();
    runtime.cancelSleep?.();
    setGameStatus(runtime.gameId, 'cancelled');
    try {
      await runtime.actions.send(templates.gameCancelledDisconnect());
    } catch (err) {
      logger.warn("Impossible de notifier le groupe de l'annulation", {
        groupId,
        error: String(err),
      });
    }
  }
  runtimeGames.clear();
}
