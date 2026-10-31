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
    const parsedUrl = new URL(req.url || '/', 'http://localhost');
    const pathname = parsedUrl.pathname;
    const theme = parsedUrl.searchParams.get('theme') || 'light';
    const isDark = theme === 'dark';

    // Enable CORS for external dashboard polling
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      return res.end();
    }

    // Color definitions for Light and Dark themes
    const t = isDark ? {
      themeName: 'dark',
      bg: '#0f172a',
      text: '#f8fafc',
      subText: '#94a3b8',
      cardBg: '#1e293b',
      cardBorder: '#334155',
      boxBg: '#0f172a',
      boxBorder: '#334155',
      badgeBg: 'rgba(16, 185, 129, 0.15)',
      badgeText: '#34d399',
      badgeBorder: 'rgba(16, 185, 129, 0.4)',
      qrBadgeBg: '#f59e0b',
      qrBadgeText: '#0f172a',
      statLabel: '#64748b',
      statVal: '#f1f5f9',
      msgHeader: '#38bdf8',
      msgBody: '#cbd5e1',
      webhookUrlColor: '#38bdf8',
      btnPrimaryBg: '#0284c7',
      btnPrimaryHover: '#0369a1',
      btnSuccessBg: '#059669',
      btnSuccessHover: '#047857',
      btnDangerBg: 'rgba(239, 68, 68, 0.15)',
      btnDangerText: '#f87171',
      btnDangerBorder: 'rgba(239, 68, 68, 0.3)',
      btnSecBg: '#334155',
      btnSecText: '#94a3b8',
      spinnerBorder: '#334155',
      spinnerTop: '#38bdf8'
    } : {
      themeName: 'light',
      bg: '#f8fafc',
      text: '#0f172a',
      subText: '#64748b',
      cardBg: '#ffffff',
      cardBorder: '#e2e8f0',
      boxBg: '#f8fafc',
      boxBorder: '#e2e8f0',
      badgeBg: '#ecfdf5',
      badgeText: '#065f46',
      badgeBorder: '#a7f3d0',
      qrBadgeBg: '#fef3c7',
      qrBadgeText: '#92400e',
      statLabel: '#64748b',
      statVal: '#0f172a',
      msgHeader: '#0284c7',
      msgBody: '#334155',
      webhookUrlColor: '#0284c7',
      btnPrimaryBg: '#0284c7',
      btnPrimaryHover: '#0369a1',
      btnSuccessBg: '#059669',
      btnSuccessHover: '#047857',
      btnDangerBg: '#fff1f2',
      btnDangerText: '#e11d48',
      btnDangerBorder: '#fecdd3',
      btnSecBg: '#f1f5f9',
      btnSecText: '#334155',
      spinnerBorder: '#e2e8f0',
      spinnerTop: '#059669'
    };

    // 1. Health / Ping endpoint (for Render & UptimeRobot keep-alive)
    if (pathname === '/health' || pathname === '/ping') {
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
    if (pathname === '/test-webhook') {
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
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>Webhook Test Sonucu</title>
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: ${t.bg}; color: ${t.text}; padding: 30px 15px; text-align: center; margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
              .box { background: ${t.cardBg}; border: 1px solid ${t.cardBorder}; padding: 28px; border-radius: 20px; max-width: 580px; width: 100%; text-align: left; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.06); }
              pre { background: ${t.boxBg}; border: 1px solid ${t.boxBorder}; padding: 14px; border-radius: 12px; color: #059669; font-size: 12px; overflow-x: auto; }
              .btn-back { display: inline-block; padding: 10px 18px; background: ${t.btnPrimaryBg}; color: white; border-radius: 10px; text-decoration: none; font-weight: 700; font-size: 13px; margin-top: 10px; }
            </style>
          </head>
          <body>
            <div class="box">
              <h2 style="color: #059669; margin-top: 0;">✅ Webhook Testi Başarılı! (HTTP ${testRes.status})</h2>
              <p style="color: ${t.subText}; font-size: 13px;">Hedef: <code style="color: ${t.webhookUrlColor};">${WEBHOOK_URL}</code></p>
              <pre>${JSON.stringify(testRes.data, null, 2)}</pre>
              <a href="/?theme=${theme}" class="btn-back">◀ Ana Ekrana Dön</a>
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
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>Webhook Test Hatası</title>
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: ${t.bg}; color: ${t.text}; padding: 30px 15px; text-align: center; margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
              .box { background: ${t.cardBg}; border: 1px solid #fecaca; padding: 28px; border-radius: 20px; max-width: 580px; width: 100%; text-align: left; }
              pre { background: ${t.boxBg}; border: 1px solid #fecaca; padding: 14px; border-radius: 12px; color: #dc2626; font-size: 12px; overflow-x: auto; }
              .btn-back { display: inline-block; padding: 10px 18px; background: ${t.btnPrimaryBg}; color: white; border-radius: 10px; text-decoration: none; font-weight: 700; font-size: 13px; margin-top: 10px; }
            </style>
          </head>
          <body>
            <div class="box">
              <h2 style="color: #dc2626; margin-top: 0;">❌ Webhook İletim Hatası!</h2>
              <p style="color: ${t.subText}; font-size: 13px;">Hedef Adres: <code>${WEBHOOK_URL}</code></p>
              <pre>${tErr.message}</pre>
              <a href="/?theme=${theme}" class="btn-back">◀ Ana Ekrana Dön</a>
            </div>
          </body>
          </html>
        `);
      }
    }

    // 3. One-Click Manual Reconnect route
    if (pathname === '/reconnect') {
      forceReconnect('Web UI Button Click');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`
        <!DOCTYPE html>
        <html lang="tr">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Bağlantı Yenileniyor...</title>
          <meta http-equiv="refresh" content="4;url=/?theme=${theme}">
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: ${t.bg}; color: ${t.text}; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; }
            .card { background: ${t.cardBg}; border: 1px solid ${t.cardBorder}; padding: 36px 28px; border-radius: 24px; text-align: center; max-width: 460px; width: 100%; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.06); }
            .spinner { width: 44px; height: 44px; border: 4px solid ${t.spinnerBorder}; border-top-color: ${t.spinnerTop}; border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 20px; }
            @keyframes spin { to { transform: rotate(360deg); } }
            h2 { margin: 0 0 10px; color: ${t.text}; font-size: 18px; font-weight: 800; }
            p { color: ${t.subText}; font-size: 13px; margin: 0 0 20px; line-height: 1.5; }
            .btn { background: ${t.btnPrimaryBg}; color: white; font-weight: 700; padding: 10px 20px; border-radius: 10px; text-decoration: none; display: inline-block; font-size: 13px; }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="spinner"></div>
            <h2>WhatsApp Bağlantısı Yenileniyor...</h2>
            <p>Mevcut soket kapatıldı ve WhatsApp sunucusu ile taze bağlantı kuruluyor. 4 saniye içinde yönlendirileceksiniz.</p>
            <a href="/?theme=${theme}" class="btn">Beklemeden Ana Ekrana Dön</a>
          </div>
        </body>
        </html>
      `);
    }

    // 4. One-Click Session Reset route (Forces new QR generation)
    if (pathname === '/reset-session') {
      resetSession();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`
        <!DOCTYPE html>
        <html lang="tr">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Oturum Sıfırlandı</title>
          <meta http-equiv="refresh" content="5;url=/?theme=${theme}">
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: ${t.bg}; color: ${t.text}; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; }
            .card { background: ${t.cardBg}; border: 1px solid ${t.cardBorder}; padding: 36px 28px; border-radius: 24px; text-align: center; max-width: 460px; width: 100%; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.06); }
            h2 { margin: 0 0 10px; color: #d97706; font-size: 18px; font-weight: 800; }
            p { color: ${t.subText}; font-size: 13px; margin: 0 0 20px; line-height: 1.5; }
            .btn { background: #d97706; color: white; font-weight: 700; padding: 10px 20px; border-radius: 10px; text-decoration: none; display: inline-block; font-size: 13px; }
          </style>
        </head>
        <body>
          <div class="card">
            <h2>⚠️ Oturum Sıfırlandı</h2>
            <p>Eski WhatsApp kimlik bilgileri silindi. Yeni Karekod (QR Kod) oluşturuluyor... 5 saniye içinde yönlendirileceksiniz.</p>
            <a href="/?theme=${theme}" class="btn">Ana Ekrana Dön</a>
          </div>
        </body>
        </html>
      `);
    }

    // 5. Main Dashboard UI (/ and /qr)
    if (pathname === '/' || pathname === '/qr') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });

      // A) If Connected
      if (connectionStatus === 'open') {
        const isWebhookSuccess = lastWebhookStatus.status.includes('BAŞARILI') || lastWebhookStatus.code === 200;
        const webhookColor = isWebhookSuccess ? '#059669' : (lastWebhookStatus.status === 'BEKLENİYOR' ? t.subText : '#dc2626');

        return res.end(`
          <!DOCTYPE html>
          <html lang="tr">
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>VillaRez WhatsApp Bot - Canlı Yönetim</title>
            <style>
              * { box-sizing: border-box; }
              body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: ${t.bg}; color: ${t.text}; margin: 0; padding: 20px; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
              .container { max-width: 600px; width: 100%; background: ${t.cardBg}; border-radius: 24px; padding: 32px 28px; border: 1px solid ${t.cardBorder}; box-shadow: 0 10px 30px -5px rgba(0,0,0,0.06); text-align: center; }
              .badge { display: inline-flex; align-items: center; gap: 8px; padding: 8px 18px; border-radius: 9999px; font-size: 13px; font-weight: 700; margin-bottom: 20px; background: ${t.badgeBg}; color: ${t.badgeText}; border: 1px solid ${t.badgeBorder}; }
              h1 { font-size: 22px; font-weight: 800; margin: 0 0 8px; color: ${t.text}; }
              p.sub { font-size: 13px; color: ${t.subText}; margin: 0 0 24px; line-height: 1.5; }
              .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 20px; text-align: left; }
              .stat-card { background: ${t.boxBg}; padding: 14px 16px; border-radius: 14px; border: 1px solid ${t.boxBorder}; }
              .stat-label { font-size: 11px; text-transform: uppercase; font-weight: 700; color: ${t.statLabel}; letter-spacing: 0.5px; margin-bottom: 4px; }
              .stat-val { font-size: 13px; font-weight: 700; color: ${t.statVal}; }
              .msg-box { background: ${t.boxBg}; padding: 16px; border-radius: 16px; border: 1px solid ${t.boxBorder}; margin-bottom: 16px; text-align: left; }
              .msg-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; font-size: 12px; font-weight: 700; color: ${t.msgHeader}; }
              .msg-text { font-size: 13px; color: ${t.msgBody}; font-style: italic; word-break: break-word; }
              .webhook-box { background: ${t.boxBg}; padding: 14px 16px; border-radius: 14px; border: 1px solid ${t.boxBorder}; margin-bottom: 24px; text-align: left; font-size: 12px; }
              .btn-group { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
              .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 11px 18px; border-radius: 12px; font-size: 12px; font-weight: 700; text-decoration: none; cursor: pointer; border: none; transition: all 0.2s; }
              .btn-primary { background: ${t.btnPrimaryBg}; color: white; }
              .btn-primary:hover { background: ${t.btnPrimaryHover}; transform: translateY(-1px); }
              .btn-success { background: ${t.btnSuccessBg}; color: white; }
              .btn-success:hover { background: ${t.btnSuccessHover}; }
              .btn-danger { background: ${t.btnDangerBg}; color: ${t.btnDangerText}; border: 1px solid ${t.btnDangerBorder}; }
              .btn-danger:hover { opacity: 0.85; }
              .footer-note { margin-top: 20px; font-size: 11px; color: ${t.subText}; }
            </style>
            <script>setTimeout(() => location.reload(), 30000);</script>
          </head>
          <body>
            <div class="container">
              <div class="badge">🟢 WhatsApp Bağlandı (Online)</div>
              <h1>VillaRez WhatsApp Bot</h1>
              <p class="sub">Gruplardan gelen rezervasyon kapatma mesajları otomatik olarak PHP onay panelinize aktarılmaktadır.</p>

              <div class="grid">
                <div class="stat-card">
                  <div class="stat-label">Bağlantı Zamanı</div>
                  <div class="stat-val" style="color: ${t.webhookUrlColor};">${formatTrTime(connectedAt)}</div>
                </div>
                <div class="stat-card">
                  <div class="stat-label">Son Canlılık Kontrolü</div>
                  <div class="stat-val" style="color: ${t.webhookUrlColor};">${formatTrTime(lastActivityAt || new Date())}</div>
                </div>
                <div class="stat-card">
                  <div class="stat-label">Alınan Mesaj Sayısı</div>
                  <div class="stat-val" style="color: #059669;">${totalProcessedMessages} Adet</div>
                </div>
                <div class="stat-card">
                  <div class="stat-label">Korumalar</div>
                  <div class="stat-val" style="font-size: 11px;">Crash Guard & Auto-Ping Aktif</div>
                </div>
              </div>

              <div class="msg-box">
                <div class="msg-header">
                  <span>📩 Son Alınan Mesaj</span>
                  <span style="color: ${t.subText}; font-size: 11px;">${lastMessageInfo?.time ? formatTrTime(lastMessageInfo.time) : '-'}</span>
                </div>
                <div class="msg-text">
                  ${lastMessageInfo ? `<strong>[${lastMessageInfo.group || 'Grup'}] ${lastMessageInfo.sender || ''}:</strong> "${lastMessageInfo.text || ''}"` : 'Henüz yeni grup mesajı gelmedi (Sistem dinlemede).'}
                </div>
              </div>

              <div class="webhook-box">
                <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
                  <span style="font-weight: 700; color: ${t.subText};">🌐 PHP Webhook Hedefi:</span>
                  <span style="font-weight: 700; color: ${webhookColor};">${lastWebhookStatus.status}</span>
                </div>
                <div style="font-family: monospace; font-size: 11px; color: ${t.webhookUrlColor}; word-break: break-all; margin-bottom: 6px;">
                  ${WEBHOOK_URL}
                </div>
                <div style="color: ${t.subText}; font-size: 11px;">
                  Son Yanıt: ${lastWebhookStatus.message ? (lastWebhookStatus.message.length > 80 ? lastWebhookStatus.message.substring(0, 80) + '...' : lastWebhookStatus.message) : '-'}
                </div>
              </div>

              <div class="btn-group">
                <a href="/test-webhook?theme=${theme}" class="btn btn-success">
                  🧪 Webhook Test Gönder
                </a>
                <a href="/reconnect?theme=${theme}" class="btn btn-primary" onclick="return confirm('WhatsApp soket bağlantısı taze olarak yeniden başlatılsın mı?');">
                  🔄 Bağlantıyı Yenile
                </a>
                <a href="/reset-session?theme=${theme}" class="btn btn-danger" onclick="return confirm('DİKKAT: Mevcut oturum sıfırlanacak ve YENİ KAREKOD üretilecektir. Onaylıyor musunuz?');">
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
                * { box-sizing: border-box; }
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; text-align: center; padding: 20px; background: ${t.bg}; color: ${t.text}; min-height: 100vh; display: flex; align-items: center; justify-content: center; margin: 0; }
                .card { background: ${t.cardBg}; padding: 32px 24px; border-radius: 24px; display: inline-block; box-shadow: 0 10px 30px -5px rgba(0,0,0,0.06); border: 1px solid ${t.cardBorder}; max-width: 440px; width: 100%; }
                .badge { background: ${t.qrBadgeBg}; color: ${t.qrBadgeText}; padding: 6px 14px; border-radius: 20px; font-weight: 800; font-size: 12px; display: inline-block; margin-bottom: 16px; border: 1px solid rgba(0,0,0,0.06); }
                .qr-box { background: white; padding: 14px; border-radius: 16px; margin: 16px auto; display: inline-block; border: 1px solid ${t.cardBorder}; box-shadow: 0 2px 8px rgba(0,0,0,0.04); }
                .qr-box svg { width: 280px; height: 280px; display: block; }
                h2 { margin: 0 0 8px; font-size: 20px; font-weight: 800; color: ${t.text}; }
                p { color: ${t.subText}; font-size: 13px; margin: 0 0 16px; line-height: 1.5; }
                .btn { display: inline-block; padding: 10px 18px; background: ${t.btnPrimaryBg}; color: white; text-decoration: none; border-radius: 10px; font-size: 12px; font-weight: 700; margin-top: 10px; transition: all 0.2s; }
                .btn:hover { background: ${t.btnPrimaryHover}; }
              </style>
              <script>setTimeout(() => location.reload(), 8000);</script>
            </head>
            <body>
              <div class="card">
                <div class="badge">Karekod Okutulması Bekleniyor</div>
                <h2>📱 WhatsApp'ı Bağlayın</h2>
                <p>Telefonunuzda <strong>WhatsApp ➔ Ayarlar ➔ Bağlı Cihazlar ➔ Cihaz Bağla</strong> kısmını açıp aşağıdaki karekodu okutun:</p>
                <div class="qr-box">${qrSvg}</div>
                <p><small style="color: ${t.subText};">Sayfa 8 saniyede bir otomatik yenilenir.</small></p>
                <a href="/reconnect?theme=${theme}" class="btn">🔄 Karekodu Yenile</a>
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
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; text-align: center; padding: 50px 20px; background: ${t.bg}; color: ${t.text}; min-height: 100vh; display: flex; align-items: center; justify-content: center; margin: 0; }
            .card { background: ${t.cardBg}; padding: 40px; border-radius: 20px; border: 1px solid ${t.cardBorder}; max-width: 420px; width: 100%; box-shadow: 0 10px 30px -5px rgba(0,0,0,0.06); }
            .spinner { width: 44px; height: 44px; border: 4px solid ${t.spinnerBorder}; border-top-color: ${t.spinnerTop}; border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 20px; }
            @keyframes spin { to { transform: rotate(360deg); } }
            h2 { margin: 0 0 10px; font-size: 18px; color: ${t.spinnerTop}; font-weight: 800; }
            p { color: ${t.subText}; font-size: 13px; margin: 0; }
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
