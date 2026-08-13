import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import { File, Storage } from 'megajs';
import { config } from '../config/config';
import { logger } from './logger';

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

/** Upload la session actuelle vers Mega et retourne le lien à utiliser comme SESSION_ID. */
export async function uploadAuthFolder(): Promise<string> {
  const buffer = zipAuthFolderToBuffer();
  const storage = await getStorage();
  const file = await storage.upload({ name: 'auth_info.zip' }, buffer).complete;
  const url = await file.link({});
  return url;
}

/** Télécharge la session depuis Mega (à partir du SESSION_ID) et la restaure sur disque. */
export async function downloadAuthFolder(sessionId: string): Promise<void> {
  const storage = await getStorage();
  const file = File.fromURL(sessionId);
  await file.loadAttributes();
  const buffer: Buffer = await file.downloadBuffer({});
  unzipBufferIntoAuthFolder(buffer);
}

/** À appeler au démarrage du bot, avant useMultiFileAuthState. */
export async function restoreSessionIfNeeded(): Promise<void> {
  const hasLocalSession =
    fs.existsSync(config.authFolder) && fs.readdirSync(config.authFolder).length > 0;
  if (hasLocalSession) return;

  if (!config.sessionHandle || !config.sessionKey) {
    logger.warn(
      "Aucun SESSION_HANDLE/SESSION_KEY configuré et aucune session locale trouvée : un QR code va être demandé."
    );
    return;
  }

  const sessionId = `https://mega.nz/file/${config.sessionHandle}#${config.sessionKey}`;
  logger.info('Restauration de la session WhatsApp depuis Mega...');
  await downloadAuthFolder(sessionId);
  logger.info('Session restaurée depuis Mega ✅');
}

// --- Ré-upload automatique, débounce pour ne pas spammer Mega ---
let reuploadTimer: ReturnType<typeof setTimeout> | null = null;
const REUPLOAD_DEBOUNCE_MS = 5000;