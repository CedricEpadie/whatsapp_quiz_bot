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

/**
 * Prend N éléments aléatoires distincts (sans remise) d'un tableau, via
 * un Fisher-Yates PARTIEL : seules les `count` dernières positions sont
 * tirées au sort, au lieu de mélanger tout le tableau pour n'en garder
 * qu'une fraction (utile quand `items` est nettement plus grand que
 * `count`, ex: 200 questions dont on n'en tire que 10). Le sous-ensemble
 * obtenu est toujours uniformément aléatoire — c'est le même algorithme
 * que `shuffle`, juste arrêté plus tôt.
 */
export function sample<T>(items: readonly T[], count: number): T[] {
  const result = [...items];
  const n = result.length;
  const k = Math.min(Math.max(count, 0), n);
  for (let i = n - 1; i >= n - k; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result.slice(n - k);
}