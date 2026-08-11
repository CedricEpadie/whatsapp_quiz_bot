import { config, type ValidChoice } from '../config/config';

const VALID: readonly string[] = config.validChoices;

/**
 * Tente d'extraire un choix A/B/C/D d'un message. Conçu pour un vrai
 * groupe WhatsApp où les gens continuent de discuter normalement et où
 * une réponse peut être écrite de façons différentes, pas juste "A".
 *
 * Reconnu :
 * - Le message est EXACTEMENT une lettre, éventuellement entourée de
 *   ponctuation usuelle : "A", "a", "A.", "(B)", "c)", "D !"
 *   -> c'est le cas le plus fréquent, géré en priorité et sans risque
 *   d'ambiguïté (avant, une simple différence de ponctuation comme
 *   "A." faisait échouer la comparaison stricte -> réponse ignorée).
 * - Une phrase contenant un mot-clé de réponse explicite suivi d'une
 *   lettre : "réponse B", "je dis C", "c'est A", "option D", "choix B"
 *   -> permet de capter une réponse formulée en phrase sans se
 *   déclencher sur du bavardage qui contiendrait juste la lettre "a"
 *   (mot très courant en français : "il a dit...").
 *
 * Volontairement PAS reconnu : une lettre isolée au milieu d'une phrase
 * sans mot-clé ("je crois que a va gagner") — trop ambigu avec le
 * français courant, ça créerait plus de faux positifs que ça n'aiderait.
 */
export function extractAnswerChoice(rawText: string): ValidChoice | null {
  const trimmed = rawText.trim();
  if (!trimmed) return null;
  const upper = trimmed.toUpperCase();

  // Cas 1 : la totalité du message est une lettre + ponctuation optionnelle.
  const soloMatch = upper.match(/^[([]?\s*([ABCD])\s*[)\].:!?,;]?$/);
  if (soloMatch) return soloMatch[1] as ValidChoice;

  // Cas 2 : phrase avec un mot-clé de réponse explicite.
  const cueMatch = trimmed.match(
    /(?:r[ée]ponse|je\s+dis|je\s+pense(?:\s+que\s+c['’]est)?|c['’]est|choix|option)\s*[:=\-]?\s*([abcdABCD])\b/
  );
  if (cueMatch) {
    const letter = cueMatch[1].toUpperCase();
    return VALID.includes(letter) ? (letter as ValidChoice) : null;
  }

  return null;
}
