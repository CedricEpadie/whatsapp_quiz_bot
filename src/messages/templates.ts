import { config } from '../config/config';
import type { PlayerScoreRow } from '../db/gameRepository';
import type { Question } from '../game/types';
import { mentionOf } from '../bot/actions';

export interface MentionedText {
  text: string;
  mentions: string[];
}

function pickRandom<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

function scoreboardLines(scoreboard: PlayerScoreRow[]): { lines: string[]; mentions: string[] } {
  const medals = ['🥇', '🥈', '🥉'];
  const lines = scoreboard.map((p, i) => {
    const rankIcon = medals[i] ?? `${i + 1}.`;
    return `${rankIcon} ${mentionOf(p.jid)} — *${p.total_points}* pts`;
  });
  return { lines, mentions: scoreboard.map((p) => p.jid) };
}

export const templates = {
  gameAlreadyRunning: (): string =>
    `⚠️ Une partie est déjà en cours ou en inscription dans ce groupe.\nUtilisez *.quizz stop* pour l'arrêter si besoin.`,

  notAllowed: (): string => `🚫 Tu n'as pas la permission de faire ça.`,

  invalidPhaseCount: (min: number, max: number): string =>
    `⚠️ Nombre de phases invalide. Choisis un nombre entre *${min}* et *${max}* ` +
    `(exemple : *.quizz ${max}*), ou tape simplement *.quizz* pour la valeur par défaut.`,

  noThemesAvailable: (): string =>
    `❌ Aucun thème de questions n'est disponible. Ajoute des fichiers JSON dans le dossier des thèmes avant de relancer.`,

  // --- Inscription ---
  registrationOpen: (durationSec: number): string =>
    `🎉✨ *NOUVEAU QUIZZ !* ✨🎉\n\n` +
    `Tapez *Partant* pour vous inscrire !\n` +
    `⏱️ Vous avez *${durationSec} secondes*. Que le meilleur gagne ! 🏆`,

  registrationReminder: (count: number, secondsLeft: number): string =>
    `⏳ *${secondsLeft}s* restantes pour s'inscrire\n` +
    `👥 *${count}* participant${count > 1 ? 's' : ''} pour l'instant\n\n` +
    `${pickRandom(config.registrationEncouragements)}\n` +
    `Tapez *Partant* pour rejoindre !`,

  playerRegistered: (name: string, count: number): string =>
    `✅ *${name}* rejoint la partie ! (${count} inscrit${count > 1 ? 's' : ''})`,

  alreadyRegistered: (): string => `ℹ️ Tu es déjà inscrit, patience 😉`,

  registrationCancelledNotEnough: (count: number): string =>
    `❌ *Partie annulée* : seulement ${count} joueur(s) inscrit(s), ${config.minPlayers} minimum requis. Réessayez avec *.quizz* !`,

  buildRegistrationClosed: (playerJids: string[], names: string[]): MentionedText => ({
    text:
      `🔒 *Inscriptions closes !* 🔒\n\n` +
      `*${names.length}* participants :\n` +
      names.map((n, i) => `${i + 1}. ${n}`).join('\n') +
      `\n\nLe quizz démarre dans quelques instants... 🚀`,
    mentions: playerJids,
  }),

  preGameRulesReminder: (phaseCount: number, questionsPerPhase: number): string =>
    `📖 *Petit rappel avant de commencer !* 📖\n\n` +
    `On va enchaîner *${phaseCount}* phases de *${questionsPerPhase}* questions.\n` +
    `Répondez avec *A*, *B*, *C* ou *D*, vous avez ${config.questionDurationMs / 1000}s par question.\n` +
    `Bonne réponse = *+${config.points.correctAnswer} pts*, et un ⚡ bonus rapidité pour les plus rapides !\n\n` +
    `C'est parti, respirez un bon coup... 😄🍀`,

  // --- Déroulement d'une phase ---
  phaseAnnounce: (phaseNumber: number, totalPhases: number, theme: string): string =>
    `┌────────────────┐\n` +
    `📚 *PHASE ${phaseNumber}/${totalPhases}*\n` +
    `🎯 Thème : *${theme.toUpperCase()}*\n` +
    `└────────────────┘\n` +
    `10 questions à suivre, bonne chance ! 🍀`,

  nextQuestion: (): string => `➡️ *Question suivante...* 👀`,

  question: (
    phaseNumber: number,
    questionNumber: number,
    totalQuestions: number,
    q: Question
  ): string =>
    `❓ *Question ${questionNumber}/${totalQuestions}* (Phase ${phaseNumber})\n\n` +
    `${q.question}\n\n` +
    `🅰️ ${q.choices.A}\n🅱️ ${q.choices.B}\n🇨 ${q.choices.C}\n🇩 ${q.choices.D}\n\n` +
    `⏱️ Répondez avec A, B, C ou D !`,

  countdown: (secondsLeft: number): string => `⏳ Temps restant : *${secondsLeft}s*`,

  stop: (): string => `🛑 *STOP !* 🛑\nTemps écoulé, plus de réponses acceptées.`,

  revealAndScores: (
    correctChoice: string,
    correctText: string,
    scored: { jid: string; name: string; points: number; speedBonus: number }[],
    majorityMissed: boolean
  ): MentionedText => {
    let text = `✅ La bonne réponse était *${correctChoice}. ${correctText}*`;
    if (majorityMissed) {
      text += `\n😮 Presque tout le monde s'est planté ! Bonus exceptionnel pour ceux qui ont trouvé.`;
    }
    if (scored.length === 0) {
      text += `\n\n😅 Personne n'a trouvé cette fois...`;
      return { text, mentions: [] };
    }
    const lines = scored.map((s) => {
      let line = `+${s.points} pour ${mentionOf(s.jid)}`;
      if (s.speedBonus > 0) {
        line += ` ⚡ bonus de rapidité +${s.speedBonus}`;
      }
      return line;
    });
    text += `\n\n${lines.join('\n')}`;
    return { text, mentions: scored.map((s) => s.jid) };
  },

  phaseSummary: (
    phaseNumber: number,
    scoreboard: PlayerScoreRow[],
    perfect: { jid: string; name: string }[]
  ): MentionedText => {
    const { lines, mentions } = scoreboardLines(scoreboard);
    let text = `🏁 *FIN DE LA PHASE ${phaseNumber}* 🏁\n\n${lines.join('\n')}`;
    const allMentions = [...mentions];
    if (perfect.length > 0) {
      text += `\n\n🌟 *Sans-faute* (+${config.points.perfectPhaseBonus} pts) : ${perfect
        .map((p) => mentionOf(p.jid))
        .join(', ')}`;
      allMentions.push(...perfect.map((p) => p.jid));
    }
    return { text, mentions: allMentions };
  },

  interPhaseBreak: (): string =>
    `☕ *Petite pause...* La phase suivante arrive dans ${config.interPhaseBreakMs / 1000}s ⏳`,

  finalResults: (scoreboard: PlayerScoreRow[], coWinners: PlayerScoreRow[]): MentionedText => {
    const { lines, mentions } = scoreboardLines(scoreboard);
    let text = `🏆✨ *RÉSULTATS FINAUX* ✨🏆\n\n${lines.join('\n')}`;
    const allMentions = [...mentions];
    if (coWinners.length > 1) {
      const names = coWinners.map((w) => mentionOf(w.jid));
      text += `\n\n🤝 *Égalité parfaite !* Co-gagnants : ${names.join(', ')} 🎉`;
      allMentions.push(...coWinners.map((w) => w.jid));
    } else if (coWinners.length === 1) {
      text += `\n\n👑 *GRAND GAGNANT : ${mentionOf(coWinners[0].jid)}* 👑🎉`;
      allMentions.push(coWinners[0].jid);
    }
    return { text, mentions: allMentions };
  },

  gameCancelledDisconnect: (): string =>
    `⚠️ Le bot a rencontré une coupure de connexion. La partie en cours a été annulée pour éviter tout blocage. Relancez avec *.quizz* quand vous voulez !`,

  gameStopped: (): string => `🛑 *Partie arrêtée.* À bientôt pour une revanche ! 👋`,

  noActiveGameToStop: (): string => `ℹ️ Il n'y a pas de partie en cours à arrêter.`,

  rules: (): string =>
    `📜 *RÈGLES DU QUIZZ* 📜\n\n` +
    `• *${config.phaseCount}* phases par défaut de *${config.questionsPerPhase}* questions ` +
    `(personnalisable via *.quizz <nombre de phases>*)\n` +
    `• Chaque question a *${config.questionDurationMs / 1000}s* : répondez avec A, B, C ou D\n` +
    `• Bonne réponse : *+${config.points.correctAnswer} pts*\n` +
    `• Si (presque) tout le monde rate (${Math.round(config.majorityMissThreshold * 100)}%+) : ` +
    `*+${config.points.majorityMissBonus} pts* pour ceux qui trouvent 😮\n` +
    `• Bonus rapidité (3 premiers corrects) : *+${config.points.speedBonus} pt* chacun, ` +
    `dès ${config.speedBonusMinPlayers} joueurs inscrits\n` +
    `• Sans-faute sur une phase entière : *+${config.points.perfectPhaseBonus} pts*\n` +
    `• Égalité en tête à la fin : départage par bonus de rapidité, puis co-victoire\n\n` +
    `▶️ Lancer une partie : *.quizz* ou *.quizz <nombre de phases>*\n` +
    `🛑 Arrêter une partie : *.quizz stop*\n` +
    `📝 Inscription : tapez *Partant* pendant la fenêtre de ${config.registrationDurationMs / 1000}s`,

  invalidContext: (): string => `⚠️ Cette commande n'est disponible que dans un groupe.`,

  internalError: (): string => `❌ Une erreur interne est survenue. La partie a été annulée par précaution.`,
};
