import 'dotenv/config';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import { uploadAuthFolder } from './utils/megaSession';
import { config } from './config/config';

async function connect(): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(config.authFolder);
  const sock = makeWASocket({ auth: state, printQRInTerminal: false });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('Scanne ce QR code avec WhatsApp :');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      console.log('✅ Pairing réussi. Upload vers Mega...');
      const sessionId = await uploadAuthFolder();
      const [handle, key] = sessionId.split('#');
      console.log('\n=== COPIE CES DEUX VALEURS ===');
      console.log('SESSION_HANDLE =', handle.replace('https://mega.nz/file/', ''));
      console.log('SESSION_KEY    =', key);
      console.log('================================\n');
      process.exit(0);
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
      if (statusCode === DisconnectReason.loggedOut) {
        console.error('Déconnecté (logout). Relance le script pour un nouveau QR code.');
        process.exit(1);
      }
      // Cas normal juste après le pairing (code 515) : on reconnecte.
      console.log('Reconnexion après pairing...');
      void connect();
    }
  });
}

connect();