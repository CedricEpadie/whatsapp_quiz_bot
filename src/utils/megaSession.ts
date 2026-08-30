import fs from 'fs';
import AdmZip from 'adm-zip';
import { Storage, type MutableFile } from 'megajs';
import { config } from '../config/config';
import { logger } from './logger';

/**
 * Nom de fichier fixe sur Mega (au lieu d'un lien public à copier dans
 * SESSION_HANDLE/SESSION_KEY). Un lien public change de handle/clé à
 * chaque nouvel upload : impossible de s'en servir pour un ré-upload
 * automatique en arrière-plan sans devoir mettre à jour une variable
 * d'environnement à chaque fois. Un nom fixe dans le compte Mega
 * authentifié n'a pas ce problème : on retrouve toujours la session en
 * cherchant ce nom, quelle que soit la fraîcheur du fichier.
 */
const SESSION_FILENAME = 'auth_info.zip';

async function getStorage(): Promise<Storage> {
  const storage = new Storage({
    email: config.megaEmail,
    password: config.megaPassword,
  });
  await storage.ready;
  return storage;
}

function zipAuthFolderToBuffer(): Buffer {
  const zip = new AdmZip();
  zip.addLocalFolder(config.authFolder);
  return zip.toBuffer();
}

function unzipBufferIntoAuthFolder(buffer: Buffer): void {
  if (!fs.existsSync(config.authFolder)) {
    fs.mkdirSync(config.authFolder, { recursive: true });
  }
  const zip = new AdmZip(buffer);
  zip.extractAllTo(config.authFolder, true);
}

function findSessionFile(storage: Storage): MutableFile | undefined {
  return storage.root.children?.find((f) => f.name === SESSION_FILENAME);
}

/** Upload la session actuelle vers Mega, en remplaçant le fichier existant s'il y en a un. */
export async function uploadAuthFolder(): Promise<void> {
  const buffer = zipAuthFolderToBuffer();
  const storage = await getStorage();
  const existing = findSessionFile(storage);
  if (existing) {
    await existing.delete(true);
  }
  await storage.upload({ name: SESSION_FILENAME }, buffer).complete;
}

/** Télécharge la session depuis Mega (par nom fixe) et la restaure sur disque. */
export async function downloadAuthFolder(): Promise<boolean> {
  const storage = await getStorage();
  const file = findSessionFile(storage);
  if (!file) return false;
  const buffer = await file.downloadBuffer({});
  unzipBufferIntoAuthFolder(buffer);
  return true;
}

/** À appeler au démarrage du bot, avant useMultiFileAuthState. */
export async function restoreSessionIfNeeded(): Promise<void> {
  const hasLocalSession =
    fs.existsSync(config.authFolder) && fs.readdirSync(config.authFolder).length > 0;
  if (hasLocalSession) return;

  if (!config.megaEmail || !config.megaPassword) {
    logger.warn(
      "Aucun MEGA_EMAIL/MEGA_PASSWORD configuré et aucune session locale trouvée : un QR code va être demandé."
    );
    return;
  }

  logger.info('Restauration de la session WhatsApp depuis Mega...');
  const restored = await downloadAuthFolder();
  if (restored) {
    logger.info('Session restaurée depuis Mega ✅');
  } else {
    logger.warn('Aucune session trouvée sur Mega : un QR code va être demandé.');
  }
}

// --- Ré-upload automatique, débounce pour ne pas spammer Mega à chaque
// rotation de creds (Baileys émet creds.update assez souvent pendant une
// session active, pas seulement au pairing initial). ---
let reuploadTimer: ReturnType<typeof setTimeout> | null = null;
const REUPLOAD_DEBOUNCE_MS = 5000;

/**
 * À appeler après chaque `saveCreds()` réussi (voir bot/connection.ts).
 * Sans cet appel, le fichier Mega reste figé à l'état du tout premier
 * `npm run generate-session` : dès que WhatsApp fait tourner les clés de
 * session (ce qui arrive naturellement en cours de vie d'une session),
 * la sauvegarde distante devient obsolète et un redémarrage la restaure
 * périmée — ce qui force un nouveau scan de QR code.
 */
export function scheduleSessionReupload(): void {
  if (!config.megaEmail || !config.megaPassword) return; // pas de backup Mega configuré
  if (reuploadTimer) return;
  reuploadTimer = setTimeout(() => {
    reuploadTimer = null;
    uploadAuthFolder()
      .then(() => logger.info('Session ré-uploadée vers Mega ✅'))
      .catch((err) =>
        logger.warn('Échec du ré-upload de session vers Mega', { error: String(err) })
      );
  }, REUPLOAD_DEBOUNCE_MS);
}
