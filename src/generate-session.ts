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
      await uploadAuthFolder();
      console.log(
        '\n✅ Session sauvegardée sur Mega (fichier "auth_info.zip").\n' +
          "Il n'y a rien d'autre à copier : tant que MEGA_EMAIL et MEGA_PASSWORD\n" +
          'sont configurés, le bot retrouve et met à jour automatiquement cette\n' +
          'sauvegarde (voir utils/megaSession.ts).\n'
      );
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