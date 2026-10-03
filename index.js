/**
 * VillaRez WhatsApp Web Baileys Listener Gateway
 * Connects to WhatsApp Web, generates terminal QR code, listens to group messages,
 * and posts incoming date-locking messages to PHP webhook: http://localhost/wp_rez/api/webhook.php
 * Supports Quoted/Reply messages & stanzaId lookup!
 */

import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import axios from 'axios';

const WEBHOOK_URL = process.env.WEBHOOK_URL || 'http://localhost/wp_rez/api/webhook.php';

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n==================================================');
      console.log('  SCAN THIS QR CODE WITH WHATSAPP TO CONNECT:');
      console.log('==================================================\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log('WhatsApp connection closed. Reconnecting:', shouldReconnect);
      if (shouldReconnect) {
        connectToWhatsApp();
      }
    } else if (connection === 'open') {
      console.log('✅ WhatsApp Web connected successfully!');
      console.log('Listening to group date-locking & cancellation reply messages...');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async (m) => {
    if (m.type === 'notify') {
      for (const msg of m.messages) {
        if (msg.key.remoteJid?.endsWith('@g.us')) {
          const groupId = msg.key.remoteJid;
          const senderId = msg.key.participant || msg.key.remoteJid;
          const senderName = msg.pushName || (msg.key.fromMe ? 'Ev Sahibi / Siz' : senderId.split('@')[0]);
          
          const messageObj = msg.message;
          const text = messageObj?.conversation 
            || messageObj?.extendedTextMessage?.text 
            || messageObj?.imageMessage?.caption 
            || '';

          // Extract quoted parent text & stanzaId from contextInfo
          const contextInfo = messageObj?.extendedTextMessage?.contextInfo 
            || messageObj?.imageMessage?.contextInfo
            || messageObj?.ephemeralMessage?.message?.extendedTextMessage?.contextInfo
            || messageObj?.ephemeralMessage?.message?.conversation?.contextInfo;

          const quotedStanzaId = contextInfo?.stanzaId || null;
          const quotedObj = contextInfo?.quotedMessage;
          
          let quotedText = quotedObj?.conversation 
            || quotedObj?.extendedTextMessage?.text 
            || quotedObj?.imageMessage?.caption 
            || '';

          if (text.trim()) {
            console.log(`\n📩 Incoming Group Message from [${senderName}]: "${text}"`);
            if (quotedText) {
              console.log(`💬 Quoted Text: "${quotedText}"`);
            }
            if (quotedStanzaId) {
              console.log(`🔗 Quoted StanzaId: "${quotedStanzaId}"`);
            }
            
            try {
              const groupMeta = await sock.groupMetadata(groupId).catch(() => ({ subject: 'WhatsApp Grubu' }));
              const groupName = groupMeta.subject || 'WhatsApp Grubu';

              const payload = {
                groupId,
                groupName,
                senderId,
                senderName,
                messageId: msg.key.id,
                messageText: text,
                quotedText: quotedText,
                quotedStanzaId: quotedStanzaId,
                timestamp: msg.messageTimestamp,
              };

              const response = await axios.post(WEBHOOK_URL, payload);
              console.log('➡️ Webhook Response:', response.data);
            } catch (err) {
              console.error('❌ Webhook posting error:', err.message);
            }
          }
        }
      }
    }
  });
}

connectToWhatsApp();
