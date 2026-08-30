import { config } from '../config/config';
import { recordAnswer, type PlayerRow } from '../db/gameRepository';
import { templates } from '../messages/templates';
import { settleQuestionScores } from './scoring';
import { extractAnswerChoice } from '../utils/answerParser';
import type { LiveQuestionState, Question } from './types';
import type { Actions } from '../bot/actions';
import type { WAMessageKey } from '@whiskeysockets/baileys';

/**
 * Traite un message potentiel de réponse (A/B/C/D) pendant qu'une
 * question est active :
 * - message pas exactement une lettre valide -> ignoré, pas d'erreur
 * - joueur ayant déjà répondu (filet mémoire immédiat + contrainte
 *   SQLite en second filet en cas de course) -> ignoré
 * - joueur non inscrit à la partie -> ignoré
 *
 * Réagit immédiatement (✅/❌) sur le message du joueur dès que sa
 * réponse est prise en compte — bien avant le message de révélation
 * qui n'arrive qu'à la fin du temps imparti.
 */
export function tryHandleAnswer(
  live: LiveQuestionState,
  gameId: number,
  playersByJid: Map<string, PlayerRow>,
  jid: string,
  rawText: string,
  messageKey: WAMessageKey,
  actions: Actions
): void {
  // Lookups O(1) d'abord (Map/Set), avant la regex : dans un groupe actif,
  // la plupart des messages viennent de non-joueurs ou de bavardage hors
  // sujet, autant filtrer au moins cher avant d'invoquer extractAnswerChoice.
  const player = playersByJid.get(jid);
  if (!player) return; // pas inscrit à cette partie

  if (live.answeredJids.has(jid)) return; // déjà répondu (filet mémoire)

  const choice = extractAnswerChoice(rawText);
  if (!choice) return;

  // Marquage mémoire immédiat pour fermer la fenêtre de concurrence avant
  // même l'écriture SQLite.
  live.answeredJids.add(jid);

  const isCorrect = choice === live.correctChoice;

  let recorded: boolean;
  try {
    recorded = recordAnswer({
      gameId,
      playerId: player.id,
      phase: live.phase,
      questionIndex: live.questionIndex,
      choice,
      isCorrect,
      answeredAt: Date.now(),
      messageKey,
    });
  } catch (err) {
    // Erreur anormale (pas un doublon) : on libère le filet mémoire pour
    // ne pas pénaliser un joueur dont la réponse n'a en réalité jamais
    // été enregistrée, et on logue pour investigation.
    live.answeredJids.delete(jid);
    console.error('[quiz] échec recordAnswer', err);
    return;
  }

  if (recorded) {
    // .catch() explicite : sans lui, un rejet (message supprimé,
    // timeout réseau) devient une unhandled rejection qui peut faire
    // planter le process en pleine partie (Semaphore.run propage les
    // erreurs, voir utils/semaphore.ts).
    actions.react(messageKey, isCorrect ? '✅' : '❌').catch((err) => {
      console.error('[quiz] échec réaction ✅/❌', err);
    });
  }
}

export interface RunQuestionResult {
  live: LiveQuestionState;
  waitForReveal: Promise<void>;
  /** Coupe le décompte et empêche la révélation si la partie est arrêtée en cours de question. */
  cancel: () => void;
}

/**
 * Envoie la question, puis un message de décompte qui est ÉDITÉ chaque
 * seconde (pas de spam : un seul message mis à jour) jusqu'à afficher
 * "🛑 STOP" à l'échéance. Calcule et annonce ensuite les scores.
 */
export function startQuestion(
  gameId: number,
  phase: number,
  questionIndex: number,
  question: Question,
  playersById: Map<number, PlayerRow>,
  actions: Actions
): RunQuestionResult {
  const live: LiveQuestionState = {
    phase,
    questionIndex,
    correctChoice: question.answer,
    answeredJids: new Set<string>(),
    deadline: Date.now() + config.questionDurationMs,
  };

  let cancelled = false;
  let resolveWait: () => void;
  const waitForReveal = new Promise<void>((r) => (resolveWait = r));
  let tickHandle: ReturnType<typeof setInterval> | null = null;

  async function resolveQuestion(countdownKey: WAMessageKey | null): Promise<void> {
    if (tickHandle) clearInterval(tickHandle);
    if (cancelled) return;

    if (countdownKey) {
      await actions.edit(countdownKey, templates.stop()).catch(() => undefined);
    }

    const { scored, majorityMissed } = settleQuestionScores(gameId, phase, questionIndex);
    const scoredWithNames = scored
      .map((s) => {
        const p = playersById.get(s.playerId);
        return p ? { jid: p.jid, name: p.display_name, points: s.points, speedBonus: s.speedBonus } : null;
      })
      .filter((s): s is { jid: string; name: string; points: number; speedBonus: number } => Boolean(s));

    const reveal = templates.revealAndScores(
      question.answer,
      question.choices[question.answer],
      scoredWithNames,
      majorityMissed
    );
    await actions.send(reveal.text, reveal.mentions);
    resolveWait();
  }

  void (async () => {
    await actions.send(
      templates.question(phase + 1, questionIndex + 1, config.questionsPerPhase, question)
    );
    if (cancelled) return;

    const initialSeconds = Math.round(config.questionDurationMs / 1000);
    const countdownMsg = await actions.send(templates.countdown(initialSeconds));
    if (cancelled) return;

    let lastShown = initialSeconds;
    // Empêche deux éditions du décompte de se chevaucher si `actions.edit`
    // met plus d'un tick (1s) à répondre — sans ce garde-fou, deux
    // éditions en vol peuvent arriver dans le désordre et faire
    // brièvement sauter le décompte affiché à une valeur incohérente.
    let editInFlight = false;
    tickHandle = setInterval(() => {
      if (editInFlight) return; // on saute ce tick plutôt que de superposer deux éditions
      void (async () => {
        const remainingMs = live.deadline - Date.now();
        const remainingSec = Math.ceil(remainingMs / 1000);

        if (remainingMs <= 0) {
          await resolveQuestion(countdownMsg.key);
          return;
        }
        if (remainingSec !== lastShown) {
          lastShown = remainingSec;
          editInFlight = true;
          try {
            await actions.edit(countdownMsg.key, templates.countdown(remainingSec)).catch(() => undefined);
          } finally {
            editInFlight = false;
          }
        }
      })();
    }, config.countdownTickMs);
  })();

  return {
    live,
    waitForReveal,
    cancel: () => {
      cancelled = true;
      if (tickHandle) clearInterval(tickHandle);
      resolveWait();
    },
  };
}