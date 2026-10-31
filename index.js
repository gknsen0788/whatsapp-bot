/**
 * VillaRez WhatsApp Web Baileys Listener Gateway
 * Connects to WhatsApp Web, generates web-based native SVG QR code UI, listens to group messages,
 * and posts incoming date-locking messages to PHP webhook.
 * 
 * Features:
 * - Anti-Crash & Auto-Recovery (Process-level error handlers, Single-instance socket lifecycle)
 * - Safe QR Pairing (Clean restart delay on status 515 pairing event)
 * - Smart Webhook URL Resolution (Auto-corrects localhost / template URLs to live takvimtakip.com.tr)
 * - Interactive Web Dashboard with Real-Time Webhook Response & Diagnostic Monitor
 * - Live Webhook Test Button (/test-webhook) & Reconnect (/reconnect)
 * - External Keep-Alive Health Endpoint (/health, /ping) for UptimeRobot / Cron
 */

// Global crash protection - Never allow Node process to exit on unhandled error
process.on('uncaughtException', (err) => {
  console.error('⚠️ [CRITICAL] Uncaught Exception caught by global guard:', err.message);
  if (err.stack) console.error(err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('⚠️ [CRITICAL] Unhandled Rejection caught by global guard:', reason);
});

import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import axios from 'axios';
import http from 'http';
import fs from 'fs';
import pino from 'pino';

// Smart Webhook URL resolution: If env has template or localhost, fallback to real live cPanel endpoint
let resolvedWebhookUrl = process.env.WEBHOOK_URL || 'https://takvimtakip.com.tr/wp/api/webhook.php';
if (!resolvedWebhookUrl || resolvedWebhookUrl.includes('localhost') || resolvedWebhookUrl.includes('siteniz.com') || resolvedWebhookUrl.includes('127.0.0.1')) {
  resolvedWebhookUrl = 'https://takvimtakip.com.tr/wp/api/webhook.php';
}
const WEBHOOK_URL = resolvedWebhookUrl;
const PORT = process.env.PORT || 3000;

let currentSock = null;
let currentQR = null;
let connectionStatus = 'connecting'; // 'connecting', 'open', 'close', 'reconnecting'
let connectedAt = null;
let lastActivityAt = null;
let lastMessageInfo = null;
let lastWebhookStatus = {
  status: 'BEKLENİYOR',
  code: null,
  message: 'Henüz bir mesaj iletilmedi.',
  time: null
};
let totalProcessedMessages = 0;
let reconnectAttempts = 0;
let isReconnecting = false;
let isConnecting = false;

// Format dates in Turkish locale string
function formatTrTime(date) {
  if (!date) return '-';
  try {
    return new Intl.DateTimeFormat('tr-TR', {
      timeZone: 'Europe/Istanbul',
      dateStyle: 'short',
      timeStyle: 'medium'
    }).format(new Date(date));
  } catch (e) {
    return new Date(date).toLocaleTimeString();
  }
}

// Cleanly close existing socket
function cleanupCurrentSocket(reason = 'cleanup') {
  if (currentSock) {
    try {
      currentSock.ev?.removeAllListeners();
      currentSock.end(new Error(reason));
    } catch (e) {
      // silent
    }
    currentSock = null;
  }
}

// Force a clean reconnect
function forceReconnect(reason = 'Manual Web Request') {
  if (isReconnecting) return;
  isReconnecting = true;
  console.log(`\n🔄 [RECONNECT TRIGGERED] Reason: ${reason} at ${new Date().toISOString()}`);
  connectionStatus = 'reconnecting';
  
  cleanupCurrentSocket(reason);

  setTimeout(() => {
    isReconnecting = false;
    connectToWhatsApp();
  }, 1500);
}

// Reset session completely and generate fresh QR
function resetSession() {
  console.log(`\n⚠️ [SESSION RESET TRIGGERED] Clearing auth_info_baileys at ${new Date().toISOString()}`);
  connectionStatus = 'connecting';
  currentQR = null;
  
  cleanupCurrentSocket('Session Reset');

  try {
    if (fs.existsSync('auth_info_baileys')) {
      fs.rmSync('auth_info_baileys', { recursive: true, force: true });
      console.log('✅ auth_info_baileys directory cleared.');
    }
  } catch (err) {
    console.error('Session clear error:', err.message);
  }

  setTimeout(() => connectToWhatsApp(), 2000);
}

// Web Server for Dashboard, QR Code, Health, Diagnostics & Reconnect Actions
http.createServer(async (req, res) => {
  try {
    const url = req.url || '/';

    // 1. Health / Ping endpoint (for Render & UptimeRobot keep-alive)
    if (url === '/health' || url === '/ping') {
      lastActivityAt = new Date();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({
        status: connectionStatus,
        webhookUrl: WEBHOOK_URL,
        lastWebhookStatus,
        connectedAt: formatTrTime(connectedAt),
        lastActivityAt: formatTrTime(lastActivityAt),
        totalProcessedMessages,
        uptimeSeconds: Math.floor(process.uptime()),
        timestamp: new Date().toISOString()
      }, null, 2));
    }

    // 2. Direct Webhook Test endpoint
    if (url === '/test-webhook') {
      try {
        const testPayload = {
          groupId: 'group_test1_ext',
          groupName: '💫 Villa test1 💫',
          senderId: '905555555555@s.whatsapp.net',
          senderName: 'Sistem Test Gönderimi',
          messageId: 'TEST_' + Date.now(),
          messageText: '10-15 Kasım satıldı',
          quotedText: '',
          quotedStanzaId: null,
          timestamp: Math.floor(Date.now() / 1000)
        };

        const testRes = await axios.post(WEBHOOK_URL, testPayload, { timeout: 12000 });
        lastWebhookStatus = {
          status: 'BAŞARILI (200 OK)',
          code: testRes.status,
          message: JSON.stringify(testRes.data),
          time: new Date()
        };

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(`
          <!DOCTYPE html>
          <html lang="tr">
          <head>
            <meta charset="utf-8">
            <title>Webhook Test Sonucu</title>
            <style>body { font-family: sans-serif; background: #0f172a; color: white; padding: 40px; text-align: center; } .box { background: #1e293b; padding: 25px; border-radius: 16px; display: inline-block; max-width: 600px; text-align: left; } pre { background: #0f172a; padding: 15px; border-radius: 8px; color: #34d399; overflow-x: auto; }</style>
          </head>
          <body>
            <div class="box">
              <h2 style="color: #34d399;">✅ Webhook Testi Başarılı! (HTTP ${testRes.status})</h2>
              <p>Hedef: <code>${WEBHOOK_URL}</code></p>
              <pre>${JSON.stringify(testRes.data, null, 2)}</pre>
              <p><a href="/" style="color: #38bdf8;">◀ Ana Sayfaya Dön</a></p>
            </div>
          </body>
          </html>
        `);
      } catch (tErr) {
        lastWebhookStatus = {
          status: 'HATA',
          code: tErr.response?.status || 'BAĞLANTI_HATASI',
          message: tErr.message,
          time: new Date()
        };
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(`
          <!DOCTYPE html>
          <html lang="tr">
          <head><meta charset="utf-8"><title>Webhook Test Hatası</title><style>body { font-family: sans-serif; background: #0f172a; color: white; padding: 40px; text-align: center; } .box { background: #1e293b; padding: 25px; border-radius: 16px; display: inline-block; max-width: 600px; text-align: left; border: 1px solid #ef4444; } pre { background: #0f172a; padding: 15px; border-radius: 8px; color: #f87171; overflow-x: auto; }</style></head>
          <body>
            <div class="box">
              <h2 style="color: #f87171;">❌ Webhook İletim Hatası!</h2>
              <p>Hedef Adres: <code>${WEBHOOK_URL}</code></p>
              <pre>${tErr.message}</pre>
              <p><a href="/" style="color: #38bdf8;">◀ Ana Sayfaya Dön</a></p>
            </div>
          </body>
          </html>
        `);
      }
    }

    // 3. One-Click Manual Reconnect route
    if (url === '/reconnect') {
      forceReconnect('Web UI Button Click');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`
        <!DOCTYPE html>
        <html lang="tr">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Bağlantı Yenileniyor...</title>
          <meta http-equiv="refresh" content="4;url=/">
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: white; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; }
            .card { background: #1e293b; padding: 40px; border-radius: 20px; text-align: center; border: 1px solid #334155; max-width: 460px; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5); }
            .spinner { width: 50px; height: 50px; border: 5px solid #334155; border-top-color: #38bdf8; border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 20px; }
            @keyframes spin { to { transform: rotate(360deg); } }
            h2 { margin: 0 0 10px; color: #38bdf8; }
            p { color: #94a3b8; font-size: 14px; margin: 0 0 20px; }
            .btn { background: #38bdf8; color: #0f172a; font-weight: bold; padding: 10px 20px; border-radius: 10px; text-decoration: none; display: inline-block; }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="spinner"></div>
            <h2>WhatsApp Bağlantısı Yenileniyor...</h2>
            <p>Mevcut soket kapatıldı ve WhatsApp sunucusu ile taze bağlantı kuruluyor. 4 saniye içinde yönlendirileceksiniz.</p>
            <a href="/" class="btn">Beklemeden Ana Sayfaya Dön</a>
          </div>
        </body>
        </html>
      `);
    }

    // 4. One-Click Session Reset route (Forces new QR generation)
    if (url === '/reset-session') {
      resetSession();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`
        <!DOCTYPE html>
        <html lang="tr">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Oturum Sıfırlandı</title>
          <meta http-equiv="refresh" content="5;url=/">
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: white; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; }
            .card { background: #1e293b; padding: 40px; border-radius: 20px; text-align: center; border: 1px solid #334155; max-width: 460px; }
            h2 { margin: 0 0 10px; color: #f59e0b; }
            p { color: #94a3b8; font-size: 14px; margin: 0 0 20px; }
            .btn { background: #f59e0b; color: #0f172a; font-weight: bold; padding: 10px 20px; border-radius: 10px; text-decoration: none; display: inline-block; }
          </style>
        </head>
        <body>
          <div class="card">
            <h2>⚠️ Oturum Sıfırlandı</h2>
            <p>Eski WhatsApp kimlik bilgileri silindi. Yeni Karekod (QR Kod) oluşturuluyor... 5 saniye içinde yönlendirileceksiniz.</p>
            <a href="/" class="btn">Ana Sayfaya Dön</a>
          </div>
        </body>
        </html>
      `);
    }

    // 5. Main Dashboard UI (/ and /qr)
    if (url === '/' || url === '/qr') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });

      // A) If Connected
      if (connectionStatus === 'open') {
        const isWebhookSuccess = lastWebhookStatus.status.includes('BAŞARILI') || lastWebhookStatus.code === 200;
        const webhookColor = isWebhookSuccess ? '#34d399' : (lastWebhookStatus.status === 'BEKLENİYOR' ? '#94a3b8' : '#f87171');

        return res.end(`
          <!DOCTYPE html>
          <html lang="tr">
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>VillaRez WhatsApp Bot - Canlı Yönetim</title>
            <style>
              * { box-sizing: border-box; }
              body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 20px; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
              .container { max-width: 600px; width: 100%; background: #1e293b; border-radius: 24px; padding: 32px 28px; border: 1px solid #334155; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5); text-align: center; }
              .badge { display: inline-flex; align-items: center; gap: 8px; padding: 8px 18px; border-radius: 9999px; font-size: 13px; font-weight: 700; margin-bottom: 20px; background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.4); }
              h1 { font-size: 22px; font-weight: 800; margin: 0 0 8px; color: #ffffff; }
              p.sub { font-size: 13px; color: #94a3b8; margin: 0 0 24px; line-height: 1.5; }
              .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 20px; text-align: left; }
              .stat-card { background: #0f172a; padding: 14px 16px; border-radius: 14px; border: 1px solid #334155; }
              .stat-label { font-size: 11px; text-transform: uppercase; font-weight: 700; color: #64748b; letter-spacing: 0.5px; margin-bottom: 4px; }
              .stat-val { font-size: 13px; font-weight: 700; color: #f1f5f9; }
              .msg-box { background: #0f172a; padding: 16px; border-radius: 16px; border: 1px solid #334155; margin-bottom: 16px; text-align: left; }
              .msg-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; font-size: 12px; font-weight: 700; color: #38bdf8; }
              .msg-text { font-size: 13px; color: #cbd5e1; font-style: italic; word-break: break-word; }
              .webhook-box { background: #0f172a; padding: 14px 16px; border-radius: 14px; border: 1px solid #334155; margin-bottom: 24px; text-align: left; font-size: 12px; }
              .btn-group { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
              .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 11px 18px; border-radius: 12px; font-size: 12px; font-weight: 700; text-decoration: none; cursor: pointer; border: none; transition: all 0.2s; }
              .btn-primary { background: #0284c7; color: white; }
              .btn-primary:hover { background: #0369a1; transform: translateY(-1px); }
              .btn-success { background: #059669; color: white; }
              .btn-success:hover { background: #047857; }
              .btn-danger { background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); }
              .btn-danger:hover { background: rgba(239, 68, 68, 0.25); }
              .footer-note { margin-top: 20px; font-size: 11px; color: #64748b; }
            </style>
            <script>setTimeout(() => location.reload(), 30000);</script>
          </head>
          <body>
            <div class="container">
              <div class="badge">🟢 WhatsApp Bağlantısı Canlı & 7/24 Aktif</div>
              <h1>WhatsApp Bot Kesintisiz Çalışıyor</h1>
              <p class="sub">Gruplardan gelen rezervasyon kapatma mesajları otomatik olarak PHP panelinize aktarılmaktadır.</p>

              <div class="grid">
                <div class="stat-card">
                  <div class="stat-label">Bağlantı Kuruldu</div>
                  <div class="stat-val">${formatTrTime(connectedAt)}</div>
                </div>
                <div class="stat-card">
                  <div class="stat-label">Son Canlılık Kontrolü</div>
                  <div class="stat-val" style="color: #38bdf8;">${formatTrTime(lastActivityAt || new Date())}</div>
                </div>
                <div class="stat-card">
                  <div class="stat-label">Alınan Mesaj Sayısı</div>
                  <div class="stat-val" style="color: #34d399;">${totalProcessedMessages} Adet</div>
                </div>
                <div class="stat-card">
                  <div class="stat-label">Korumalar</div>
                  <div class="stat-val" style="font-size: 11px;">Crash Guard & Auto-Ping Aktif</div>
                </div>
              </div>

              <div class="msg-box">
                <div class="msg-header">
                  <span>📩 Son Alınan Mesaj</span>
                  <span style="color: #64748b; font-size: 11px;">${lastMessageInfo?.time ? formatTrTime(lastMessageInfo.time) : '-'}</span>
                </div>
                <div class="msg-text">
                  ${lastMessageInfo ? `<strong>[${lastMessageInfo.group || 'Grup'}] ${lastMessageInfo.sender || ''}:</strong> "${lastMessageInfo.text || ''}"` : 'Henüz yeni grup mesajı gelmedi (Sistem dinlemede).'}
                </div>
              </div>

              <div class="webhook-box">
                <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
                  <span style="font-weight: 700; color: #94a3b8;">🌐 PHP Webhook Hedefi:</span>
                  <span style="font-weight: 700; color: ${webhookColor};">${lastWebhookStatus.status}</span>
                </div>
                <div style="font-family: monospace; font-size: 11px; color: #38bdf8; word-break: break-all; margin-bottom: 6px;">
                  ${WEBHOOK_URL}
                </div>
                <div style="color: #64748b; font-size: 11px;">
                  Son Yanıt: ${lastWebhookStatus.message ? (lastWebhookStatus.message.length > 80 ? lastWebhookStatus.message.substring(0, 80) + '...' : lastWebhookStatus.message) : '-'}
                </div>
              </div>

              <div class="btn-group">
                <a href="/test-webhook" class="btn btn-success" target="_blank">
                  🧪 Webhook Test Gönder
                </a>
                <a href="/reconnect" class="btn btn-primary" onclick="return confirm('WhatsApp soket bağlantısı taze olarak yeniden başlatılsın mı?');">
                  🔄 Bağlantıyı Yenile
                </a>
                <a href="/reset-session" class="btn btn-danger" onclick="return confirm('DİKKAT: Mevcut oturum sıfırlanacak ve YENİ KAREKOD üretilecektir. Onaylıyor musunuz?');">
                  🔑 Oturumu Sıfırla
                </a>
              </div>

              <div class="footer-note">
                Sistem 7/24 kesintisiz çalışmaktadır.
              </div>
            </div>
          </body>
          </html>
        `);
      }

      // B) If QR Code is Available
      if (currentQR) {
        try {
          const qrSvg = await QRCode.toString(currentQR, { type: 'svg', margin: 2 });
          return res.end(`
            <!DOCTYPE html>
            <html lang="tr">
            <head>
              <meta charset="utf-8">
              <meta name="viewport" content="width=device-width, initial-scale=1">
              <title>WhatsApp Bot - Karekod Bağlantısı</title>
              <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; text-align: center; padding: 20px; background: #0f172a; color: white; min-height: 100vh; display: flex; align-items: center; justify-content: center; margin: 0; }
                .card { background: #1e293b; padding: 32px 24px; border-radius: 24px; display: inline-block; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5); border: 1px solid #334155; max-width: 440px; width: 100%; }
                .badge { background: #f59e0b; color: #0f172a; padding: 6px 14px; border-radius: 20px; font-weight: 800; font-size: 12px; display: inline-block; margin-bottom: 16px; }
                .qr-box { background: white; padding: 14px; border-radius: 16px; margin: 16px auto; display: inline-block; }
                .qr-box svg { width: 280px; height: 280px; display: block; }
                h2 { margin: 0 0 8px; font-size: 20px; }
                p { color: #94a3b8; font-size: 13px; margin: 0 0 16px; line-height: 1.4; }
                .btn { display: inline-block; padding: 10px 18px; background: #334155; color: #94a3b8; text-decoration: none; border-radius: 10px; font-size: 12px; font-weight: 700; margin-top: 10px; }
                .btn:hover { color: white; background: #475569; }
              </style>
              <script>setTimeout(() => location.reload(), 10000);</script>
            </head>
            <body>
              <div class="card">
                <div class="badge">Karekod Okutulması Bekleniyor</div>
                <h2>📱 WhatsApp'ı Bağlayın</h2>
                <p>Telefonunuzda <strong>WhatsApp ➔ Ayarlar ➔ Bağlı Cihazlar ➔ Cihaz Bağla</strong> kısmını açıp aşağıdaki karekodu okutun:</p>
                <div class="qr-box">${qrSvg}</div>
                <p><small style="color: #64748b;">Sayfa 10 saniyede bir otomatik yenilenir.</small></p>
                <a href="/reconnect" class="btn">🔄 Karekodu Yenile</a>
              </div>
            </body>
            </html>
          `);
        } catch (err) {
          return res.end('<h1>Karekod oluşturma hatası: ' + err.message + '</h1>');
        }
      }

      // C) If Reconnecting / Initializing
      return res.end(`
        <!DOCTYPE html>
        <html lang="tr">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Bağlantı Hazırlanıyor</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; text-align: center; padding: 50px 20px; background: #0f172a; color: white; min-height: 100vh; display: flex; align-items: center; justify-content: center; margin: 0; }
            .card { background: #1e293b; padding: 40px; border-radius: 20px; border: 1px solid #334155; max-width: 420px; width: 100%; }
            .spinner { width: 44px; height: 44px; border: 4px solid #334155; border-top-color: #38bdf8; border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 20px; }
            @keyframes spin { to { transform: rotate(360deg); } }
            h2 { margin: 0 0 10px; font-size: 18px; color: #38bdf8; }
            p { color: #94a3b8; font-size: 13px; margin: 0; }
          </style>
          <script>setTimeout(() => location.reload(), 3000);</script>
        </head>
        <body>
          <div class="card">
            <div class="spinner"></div>
            <h2>⏳ WhatsApp Bağlantısı Başlatılıyor...</h2>
            <p>Oturum doğrulanıyor, lütfen bekleyin. Sayfa 3 saniye içinde otomatik yenilenecektir.</p>
          </div>
        </body>
        </html>
      `);
    }

    res.writeHead(404);
    res.end('Not Found');
  } catch (serverErr) {
    console.error('Server error:', serverErr);
    try {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error: ' + serverErr.message);
    } catch (e) {}
  }
}).listen(PORT, () => {
  console.log(`🌐 Web Management & QR server running on port ${PORT}`);
});

// Self-Ping Keep-Alive interval every 3 minutes
setInterval(async () => {
  try {
    const pingTarget = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}/ping`;
    await axios.get(pingTarget, { timeout: 8000 });
  } catch (e) {
    // Keep-alive silent catch
  }
}, 3 * 60 * 1000);

// Watchdog: Detects dead/zombie WebSockets every 90 seconds
setInterval(() => {
  try {
    if (connectionStatus === 'open' && currentSock) {
      const isWsOpen = currentSock.ws?.socket?._readyState === 1 || currentSock.ws?.isOpen;
      if (isWsOpen === false) {
        console.log(`⚠️ [WATCHDOG] Dead socket detected. Auto-reconnecting...`);
        forceReconnect('Watchdog detected closed socket');
      } else {
        lastActivityAt = new Date();
      }
    }
  } catch (e) {
    console.error('Watchdog error:', e.message);
  }
}, 90 * 1000);

async function connectToWhatsApp() {
  if (isConnecting) return;
  isConnecting = true;

  try {
    cleanupCurrentSocket('Starting new connectToWhatsApp');

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    // Anti-Ban & Safe Connection Configuration with silent logger
    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['Ubuntu', 'Chrome', '124.0.0.0'],
      markOnlineOnConnect: false,
      syncFullHistory: false,
      keepAliveIntervalMs: 25000,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
    });

    currentSock = sock;

    sock.ev.on('connection.update', (update) => {
      try {
        const { connection, lastDisconnect, qr } = update;
        lastActivityAt = new Date();

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
          const isLoggedOut = statusCode === DisconnectReason.loggedOut;
          const isRestartRequired = statusCode === DisconnectReason.restartRequired;

          console.log(`WhatsApp connection closed (Status ${statusCode})...`);

          if (isLoggedOut) {
            console.log('⚠️ Session logged out. Clearing auth_info_baileys to generate new QR...');
            currentQR = null;
            try {
              fs.rmSync('auth_info_baileys', { recursive: true, force: true });
            } catch (err) {}
            setTimeout(() => connectToWhatsApp(), 2000);
          } else if (isRestartRequired) {
            console.log('🔄 QR Pairing confirmed! Reconnecting cleanly in 2s (Restart Required)...');
            currentQR = null;
            cleanupCurrentSocket('Restart Required');
            setTimeout(() => connectToWhatsApp(), 2000);
          } else {
            reconnectAttempts++;
            const delay = Math.min(reconnectAttempts * 2000, 20000);
            console.log(`Reconnecting in ${delay / 1000}s (Attempt ${reconnectAttempts})...`);
            cleanupCurrentSocket('Auto Reconnect');
            setTimeout(() => connectToWhatsApp(), delay);
          }
        } else if (connection === 'open') {
          currentQR = null;
          connectionStatus = 'open';
          reconnectAttempts = 0;
          connectedAt = new Date();
          lastActivityAt = new Date();
          console.log('✅ WhatsApp Web connected safely with Official Chrome Fingerprint!');
          console.log('Listening passively to group date-locking & cancellation messages...');
        }
      } catch (connErr) {
        console.error('Connection update error:', connErr.message);
      }
    });

    sock.ev.on('creds.update', async () => {
      try {
        await saveCreds();
      } catch (err) {
        console.error('Error saving credentials:', err.message);
      }
    });

    sock.ev.on('messages.upsert', async (m) => {
      try {
        lastActivityAt = new Date();

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
                
                try {
                  const groupMeta = await sock.groupMetadata(groupId).catch(() => ({ subject: 'WhatsApp Grubu' }));
                  const groupName = groupMeta.subject || 'WhatsApp Grubu';

                  lastMessageInfo = {
                    group: groupName,
                    sender: senderName,
                    text: text.length > 90 ? text.substring(0, 90) + '...' : text,
                    time: new Date()
                  };
                  totalProcessedMessages++;

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

                  try {
                    const response = await axios.post(WEBHOOK_URL, payload, { timeout: 15000 });
                    lastWebhookStatus = {
                      status: 'BAŞARILI (HTTP ' + response.status + ')',
                      code: response.status,
                      message: typeof response.data === 'object' ? JSON.stringify(response.data) : String(response.data),
                      time: new Date()
                    };
                    console.log('➡️ Webhook Response:', response.data);
                  } catch (postErr) {
                    lastWebhookStatus = {
                      status: 'İLETİM HATASI',
                      code: postErr.response?.status || 'AĞ_HATASI',
                      message: postErr.message,
                      time: new Date()
                    };
                    console.error('❌ Webhook posting error:', postErr.message);
                  }
                } catch (procErr) {
                  console.error('❌ Message processing error:', procErr.message);
                }
              }
            }
          }
        }
      } catch (msgErr) {
        console.error('Error in messages.upsert handler:', msgErr.message);
      }
    });

  } catch (initErr) {
    console.error('Error in connectToWhatsApp:', initErr.message);
    setTimeout(() => connectToWhatsApp(), 3000);
  } finally {
    isConnecting = false;
  }
}

connectToWhatsApp();
