/**
 * setTimeout(fn, N) enchaîné 60+ fois accumule de la dérive (temps
 * d'exécution des callbacks, latence de la boucle d'événements, I/O
 * réseau vers WhatsApp). Sur une partie de ~40 minutes, ça peut se
 * chiffrer en secondes de décalage.
 *
 * Ici on calcule une échéance absolue (Date.now() + duration) et on
 * programme un setTimeout dont le délai est recalculé pour viser
 * exactement cette échéance, quelle que soit la latence d'appel.
 */
export class DeadlineTimer {
  private handle: ReturnType<typeof setTimeout> | null = null;
  private cancelled = false;

  /** Démarre un timer visant l'échéance donnée et retourne l'échéance (ms epoch). */
  start(durationMs: number, onFire: () => void): number {
    const deadline = Date.now() + durationMs;
    this.schedule(deadline, onFire);
    return deadline;
  }

  private schedule(deadline: number, onFire: () => void): void {
    const remaining = deadline - Date.now();
    this.handle = setTimeout(() => {
      if (this.cancelled) return;
      if (Date.now() >= deadline) {
        onFire();
      } else {
        // Réveil en avance (rare, mais possible) : on reprogramme le reliquat.
        this.schedule(deadline, onFire);
      }
    }, Math.max(remaining, 0));
  }

  cancel(): void {
    this.cancelled = true;
    if (this.handle) {
      clearTimeout(this.handle);
      this.handle = null;
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
