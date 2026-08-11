import type { ValidChoice } from '../config/config';

/**
 * Format stocké dans les fichiers JSON de thème. Les 4 propositions
 * sont une liste simple (pas de lettre figée par proposition) : c'est
 * ce qui permet de mélanger leur ordre à chaque partie sans avoir à
 * réécrire les questions — voir questionLoader.pickQuestionsForPhase.
 */
export interface RawQuestion {
  question: string;
  /** Exactement 4 propositions, dans l'ordre d'origine du fichier. */
  choices: string[];
  /** Index (0-3) de la bonne proposition dans `choices`. */
  correctIndex: number;
}

export interface ThemeFile {
  theme: string;
  questions: RawQuestion[];
}

/**
 * Format "prêt à jouer" d'une question, obtenu après mélange aléatoire
 * des propositions d'une RawQuestion (une fois par partie). C'est ce
 * format qu'utilisent le moteur de jeu et les templates de message.
 */
export interface Question {
  question: string;
  choices: {
    A: string;
    B: string;
    C: string;
    D: string;
  };
  answer: ValidChoice;
}

/**
 * State "vivant" d'une question en cours de résolution, gardé en mémoire
 * process (pas en base, car éphémère et propre à un timer en cours).
 * Sert à savoir quels joueurs ont déjà répondu dans le tick courant
 * avant même l'écriture en base (garde-fou en plus de la contrainte
 * UNIQUE côté SQLite).
 */
export interface LiveQuestionState {
  phase: number;
  questionIndex: number;
  correctChoice: string;
  answeredJids: Set<string>;
  deadline: number; // timestamp epoch ms
}

/** Sens applicatif d'une partie identifiée en base par son id + groupe. */
export interface ActiveGameHandle {
  gameId: number;
  groupId: string;
}
