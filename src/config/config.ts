import 'dotenv/config';

/**
 * Toute la configuration "métier" du quizz vit ici.
 * Objectif : pouvoir changer un barème, une durée ou un seuil
 * sans toucher à la logique de jeu dans game/*.
 */
export const config = {
  // --- Qui peut lancer .quizz / .quizz stop ---
  // 'linkedAccount' (défaut) : seul le compte WhatsApp lié au bot (celui
  //   qui a scanné le QR code) peut lancer/arrêter une partie. Détecté via
  //   le flag `fromMe` de Baileys — pas de JID à configurer.
  // 'everyone' : n'importe qui dans le groupe peut lancer/arrêter .quizz.
  commandAccessMode:
    (process.env.QUIZZ_ACCESS_MODE as 'linkedAccount' | 'everyone' | undefined) ??
    'linkedAccount',

  // --- Stockage ---
  authFolder: process.env.AUTH_FOLDER ?? './auth_info',
  dbPath: process.env.DB_PATH ?? './data/quiz.db',
  megaEmail : process.env.MEGA_EMAIL ?? '',
  megaPassword : process.env.MEGA_PASSWORD ?? '',
  sessionHandle: process.env.SESSION_HANDLE ?? '',
  sessionKey: process.env.SESSION_KEY ?? '',

  // --- Reconnexion ---
  disconnectCancelTimeoutMs: Number(
    process.env.DISCONNECT_CANCEL_TIMEOUT_MS ?? 15000
  ),

  // --- Structure de la partie ---
  // Nombre de phases par défaut si `.quizz` est lancé sans argument.
  // Un nombre différent peut être demandé via `.quizz <n>`, dans la
  // limite du nombre de thèmes disponibles (pas de répétition de thème
  // dans une même partie).
  phaseCount: 6,
  questionsPerPhase: 10,

  // --- Timing ---
  registrationDurationMs: 60_000,
  registrationReminderIntervalMs: 10_000, // rappel toutes les 10s pendant l'inscription
  registrationClosedPauseMs: 3_000, // laisser le temps de lire la liste des inscrits
  rulesReadPauseMs: 9_000, // laisser le temps de lire le rappel des règles avant de commencer
  phaseAnnouncePauseMs: 5_000, // laisser le temps de lire le thème avant la 1re question
  questionDurationMs: 15_000,
  countdownTickMs: 1_000, // fréquence de mise à jour du décompte affiché
  interPhaseBreakMs: 18_000, // entre 15 et 20s, cf. cahier des charges
  phaseSummaryPauseMs: 6_000, // laisser le temps de lire le classement de fin de phase
  revealPauseMs: 5_000, // pause après révélation avant la question suivante
  nextQuestionAnnounceMs: 2_500, // pause après "Question suivante" avant l'envoi

  // --- Joueurs ---
  minPlayers: 2,
  speedBonusMinPlayers: 6, // seuil d'activation du bonus de rapidité

  // --- Performance / robustesse à grande échelle ---
  // Nombre maximum d'appels concurrents vers l'API WhatsApp (envoi,
  // édition, réaction). Limite le risque de throttling/instabilité de
  // session quand beaucoup de joueurs répondent au même instant.
  maxConcurrentWhatsAppCalls: 24,

  // --- Barème de points ---
  points: {
    correctAnswer: 2,
    speedBonus: 1, // par joueur, pour les 3 premiers corrects
    speedBonusRankCount: 3,
    perfectPhaseBonus: 5,
    // Si un fort pourcentage de joueurs ratent la question, la bonne
    // réponse devient plus valorisée (remplace correctAnswer, pas cumulatif).
    majorityMissBonus: 4,
  },
  // Seuil de "majorité ratée" : si (joueurs en échec / joueurs inscrits)
  // atteint ou dépasse cette proportion, majorityMissBonus s'applique.
  majorityMissThreshold: 0.75,

  // --- Divers ---
  validChoices: ['A', 'B', 'C', 'D'] as const,
  registrationKeyword: 'partant',

  // Messages d'encouragement piochés aléatoirement pour les rappels
  // d'inscription (toutes les registrationReminderIntervalMs).
  registrationEncouragements: [
    "Qui sera le grand vainqueur ce soir ? 🏆",
    "Un nouveau champion va-t-il émerger ? 🥇",
    "Ne restez pas spectateurs, venez jouer ! 🎮",
    "Encore quelques places pour les plus courageux 💪",
    "La culture générale n'attend que vous 🧠",
    "Rejoignez la partie avant qu'il ne soit trop tard ⏳",
  ],
} as const;

export type ValidChoice = (typeof config.validChoices)[number];
