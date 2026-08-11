/**
 * Mélange Fisher-Yates. Retourne un NOUVEAU tableau (n'altère jamais
 * l'original) — important ici car les tableaux de questions viennent
 * du cache de thèmes chargé une fois au démarrage et partagé entre
 * toutes les parties.
 */
export function shuffle<T>(items: readonly T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/** Prend N éléments aléatoires distincts (sans remise) d'un tableau. */
export function sample<T>(items: readonly T[], count: number): T[] {
  return shuffle(items).slice(0, count);
}
