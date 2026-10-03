/**
 * VillaRez WhatsApp Web Baileys Listener Gateway
 * Connects to WhatsApp Web, generates web-based native SVG QR code UI, listens to group messages,
 * and posts incoming date-locking messages to PHP webhook.
 * Includes Anti-Ban & Connection Protection (Browser Fingerprinting, Passive Mode & Reconnection Backoff).
 */

import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import axios from 'axios';
import http from 'http';

const WEBHOOK_URL = process.env.WEBHOOK_URL || 'http://localhost/wp_rez/api/webhook.php';
const PORT = process.env.PORT || 3000;

let currentQR = null;
let connectionStatus = 'connecting';
let reconnectAttempts = 0;

// Web Server for Native SVG QR Code Display & Health Check
http.createServer(async (req, res) => {
  if (req.url === '/' || req.url === '/qr') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (connectionStatus === 'open') {
      res.end(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>WhatsApp Bot - Aktif</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; text-align: center; padding: 40px; background: #0f172a; color: white; }
            .card { background: #1e293b; padding: 40px; border-radius: 16px; display: inline-block; box-shadow: 0 10px 25px rgba(0,0,0,0.3); border: 1px solid #334155; }
            .badge { background: #10b981; color: white; padding: 8px 16px; border-radius: 20px; font-weight: bold; display: inline-block; margin-bottom: 20px; }
            .info { color: #94a3b8; font-size: 14px; margin-top: 15px; }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="badge">✅ WhatsApp Bağlantısı Güvenli & Aktif</div>
            <h2>WhatsApp Bot 7/24 Kesintisiz Çalışıyor!</h2>
            <p style="color: #94a3b8;">Gruplardan gelen rezervasyon kapatma mesajları otomatik olarak PHP panelinize aktarılmaktadır.</p>
            <div class="info">🛡️ Anti-Ban Koruması: Pasif Okuyucu Modu | Official Chrome Desktop Fingerprint</div>
          </div>
        </body>
        </html>
      `);
    } else if (currentQR) {
      try {
        const qrSvg = await QRCode.toString(currentQR, { type: 'svg', margin: 2 });
        res.end(`
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>WhatsApp Bot Karekod Bağlantısı</title>
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; text-align: center; padding: 30px; background: #0f172a; color: white; }
              .card { background: #1e293b; padding: 30px; border-radius: 16px; display: inline-block; box-shadow: 0 10px 25px rgba(0,0,0,0.3); border: 1px solid #334155; max-width: 420px; }
              .qr-box { background: white; padding: 15px; border-radius: 12px; margin: 20px auto; display: inline-block; }
              .qr-box svg { width: 300px; height: 300px; }
            </style>
            <script>setTimeout(() => location.reload(), 10000);</script>
          </head>
          <body>
            <div class="card">
              <h2>📱 WhatsApp Bağlantısı</h2>
              <p style="color: #94a3b8; font-size: 14px;">WhatsApp ➔ Bağlı Cihazlar ➔ Cihaz Bağla kısmından okutun:</p>
              <div class="qr-box">${qrSvg}</div>
              <p><small style="color: #64748b;">Sayfa 10 saniyede bir otomatik yenilenir.</small></p>
            </div>
          </body>
          </html>
        `);
      } catch (err) {
        res.end('<h1>Karekod çizilirken hata oluştu: ' + err.message + '</h1>');
      }
    } else {
      res.end(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <title>Karekod Hazırlanıyor</title>
          <style>body { font-family: sans-serif; text-align: center; padding: 50px; background: #0f172a; color: white; }</style>
          <script>setTimeout(() => location.reload(), 4000);</script>
        </head>
        <body>
          <h2>⏳ Karekod Oluşturuluyor...</h2>
          <p>Lütfen bekleyin, sayfa 4 saniye sonra otomatik yenilenecek.</p>
        </body>
        </html>
      `);
    }
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
}).listen(PORT, () => {
  console.log(`🌐 Web QR server running on port ${PORT}`);
});

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  // Anti-Ban & Safe Connection Configuration
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    // 1. Official Browser Fingerprint (Appears as standard Desktop Chrome on Mac/Ubuntu)
    browser: ['Ubuntu', 'Chrome', '124.0.0.0'],
    // 2. Mark socket as Passive Receiver (does not force online state or send status updates)
    markOnlineOnConnect: false,
    syncFullHistory: false,
    // 3. Keep-alive heartbeat & timeout settings
    keepAliveIntervalMs: 30000,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = qr;
      connectionStatus = 'connecting';
      console.log('\n==================================================');
      console.log('  NEW QR CODE GENERATED - VISIT WEB PAGE TO SCAN');
      console.log('==================================================\n');
      qrcodeTerminal.generate(qr, { small: true });
    }

    if (connection === 'close') {
      connectionStatus = 'close';
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      reconnectAttempts++;
      const delay = Math.min(reconnectAttempts * 3000, 30000); // Exponential backoff max 30s
      console.log(`WhatsApp connection closed (Status ${statusCode}). Reconnecting in ${delay / 1000}s...`);

      if (shouldReconnect) {
        setTimeout(() => connectToWhatsApp(), delay);
      }
    } else if (connection === 'open') {
      currentQR = null;
      connectionStatus = 'open';
      reconnectAttempts = 0;
      console.log('✅ WhatsApp Web connected safely with Official Chrome Fingerprint!');
      console.log('Listening passively to group date-locking & cancellation messages...');
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
