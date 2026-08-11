import fs from 'fs';
import path from 'path';
import { config, type ValidChoice } from '../config/config';
import type { ThemeFile, RawQuestion, Question } from '../game/types';
import { logger } from '../utils/logger';
import { sample, shuffle } from '../utils/random';

const THEMES_DIR = path.join(__dirname, 'data', 'themes');
const LETTERS: readonly ValidChoice[] = ['A', 'B', 'C', 'D'];

function isValidQuestion(q: unknown): q is RawQuestion {
  if (typeof q !== 'object' || q === null) return false;
  const question = q as Record<string, unknown>;
  if (typeof question.question !== 'string' || !question.question.trim()) return false;
  if (!Array.isArray(question.choices) || question.choices.length !== 4) return false;
  if (!question.choices.every((c) => typeof c === 'string' && c.trim().length > 0)) return false;
  if (typeof question.correctIndex !== 'number' || !Number.isInteger(question.correctIndex)) {
    return false;
  }
  if (question.correctIndex < 0 || question.correctIndex > 3) return false;
  return true;
}

function loadThemeFile(filePath: string): ThemeFile {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Fichier de questions introuvable : ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`JSON invalide dans ${filePath} : ${(err as Error).message}`);
  }
  const data = parsed as Partial<ThemeFile>;
  if (typeof data.theme !== 'string' || !Array.isArray(data.questions)) {
    throw new Error(`Structure invalide dans ${filePath} (attendu: { theme, questions[] })`);
  }
  if (data.questions.length < config.questionsPerPhase) {
    throw new Error(
      `${filePath} contient ${data.questions.length} question(s), au moins ${config.questionsPerPhase} attendues ` +
        `(un sous-ensemble aléatoire de ${config.questionsPerPhase} sera tiré à chaque partie)`
    );
  }
  for (const [i, q] of data.questions.entries()) {
    if (!isValidQuestion(q)) {
      throw new Error(
        `Question invalide à l'index ${i} dans ${filePath} ` +
          `(attendu : { question: string, choices: [4 strings], correctIndex: 0-3 })`
      );
    }
  }
  return data as ThemeFile;
}

/**
 * Charge tous les thèmes disponibles dans data/themes/*.json.
 * Exige au moins un thème valide ; le nombre de phases réellement
 * jouables dans une partie donnée (limité par le nombre de thèmes
 * disponibles) est vérifié séparément au lancement de `.quizz`.
 */
export function loadAllThemes(): ThemeFile[] {
  if (!fs.existsSync(THEMES_DIR)) {
    throw new Error(`Dossier de thèmes introuvable : ${THEMES_DIR}`);
  }
  const files = fs
    .readdirSync(THEMES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();

  if (files.length === 0) {
    throw new Error(`Aucun fichier de thème trouvé dans ${THEMES_DIR}`);
  }

  const themes = files.map((f) => loadThemeFile(path.join(THEMES_DIR, f)));
  logger.info(`${themes.length} thème(s) chargé(s) : ${themes.map((t) => t.theme).join(', ')}`);
  return themes;
}

/**
 * Sélectionne aléatoirement `phaseCount` thèmes DISTINCTS parmi tous
 * ceux disponibles (sans remise : un même thème ne peut pas apparaître
 * deux fois dans une même partie). L'ordre de sélection détermine
 * l'ordre des phases.
 */
export function pickThemesForGame(allThemes: ThemeFile[], phaseCount: number): ThemeFile[] {
  return sample(allThemes, phaseCount);
}

/**
 * Convertit une RawQuestion (choices en liste + correctIndex) en
 * Question "prête à jouer" (choices.A/B/C/D + answer), en mélangeant
 * aléatoirement l'ordre des propositions. Résultat : la bonne réponse
 * n'est PAS toujours associée à la même lettre d'une partie à l'autre,
 * même pour une question identique.
 */
function shuffleChoicesIntoLetters(raw: RawQuestion): Question {
  // `order[i]` = index original (dans raw.choices) placé en position i.
  const order = shuffle([0, 1, 2, 3]);
  const choices = {} as Question['choices'];
  let answer: ValidChoice = 'A';

  order.forEach((originalIndex, position) => {
    const letter = LETTERS[position];
    choices[letter] = raw.choices[originalIndex];
    if (originalIndex === raw.correctIndex) {
      answer = letter;
    }
  });

  return { question: raw.question, choices, answer };
}

/**
 * Sélectionne aléatoirement `config.questionsPerPhase` questions
 * DISTINCTES au sein d'un thème (sans remise), puis mélange les
 * propositions de chacune indépendamment (voir shuffleChoicesIntoLetters).
 */
export function pickQuestionsForPhase(theme: ThemeFile): Question[] {
  return sample(theme.questions, config.questionsPerPhase).map(shuffleChoicesIntoLetters);
}
