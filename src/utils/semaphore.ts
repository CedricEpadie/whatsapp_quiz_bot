/**
 * Limite le nombre d'opérations async concurrentes. Utilisé pour
 * éviter d'envoyer une rafale de dizaines d'appels réseau simultanés
 * vers WhatsApp (envoi de messages, éditions de décompte, réactions)
 * quand un grand nombre de joueurs répondent à la même seconde — ce
 * genre de rafale est une cause plausible d'instabilité de session
 * (renégociations de clés Signal, messages perdus) sur une connexion
 * Baileys locale.
 */
export class Semaphore {
  private active = 0;
  private queue: (() => void)[] = [];

  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}
