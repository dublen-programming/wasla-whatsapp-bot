const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const http = require('http');
const https = require('https');
const pino = require('pino');
const path = require('path');

// === Supabase Config ===
const SUPABASE_URL = 'https://zdgtfeisltmdchzyvjvr.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpkZ3RmZWlzbHRtZGNoenl2anZyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjA0NTk4MDUsImV4cCI6MjA3NjAzNTgwNX0.LNV972swlR0FFR3s50-V3QzpwQQ8vEOj8UVYsddzns4';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

let sock = null;
let currentQRCodeDataURL = '';
const processedOrders = new Set(); // لمنع تكرار الإشعارات لنفس الطلب

// HTTP Server to display status and clear QR Code
const PORT = process.env.PORT || 3000;
const server = http.createServer(async (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  if (sock && sock.user) {
    res.end(`
      <!DOCTYPE html>
      <html>
      <head><title>Wasla WhatsApp Bot</title><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
      <body style="font-family: Arial; text-align: center; padding: 50px; background: #f0f2f5;">
        <h1 style="color: #25D366;">🟢 Wasla WhatsApp Bot is ONLINE & CONNECTED!</h1>
        <p style="font-size: 18px;">Connected Number: <b>${sock.user.id.split(':')[0]}</b></p>
        <p style="color: #666;">Monitoring Supabase Realtime + Auto Polling Active</p>
      </body>
      </html>
    `);
  } else if (currentQRCodeDataURL) {
    res.end(`
      <!DOCTYPE html>
      <html>
      <head><title>Scan QR Code - Wasla Bot</title><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
      <body style="font-family: Arial; text-align: center; padding: 30px; background: #f0f2f5;">
        <h2 style="color: #075E54;">📱 Scan QR Code with WhatsApp Business (01017323187)</h2>
        <div style="background: white; display: inline-block; padding: 20px; border-radius: 15px; box-shadow: 0 4px 10px rgba(0,0,0,0.1);">
          <img src="${currentQRCodeDataURL}" width="300" height="300" style="border: 2px solid #25D366; border-radius: 10px;" />
        </div>
        <p style="color: #666; margin-top: 15px;">Open WhatsApp -> Linked Devices -> Scan QR Code</p>
        <script>setTimeout(() => location.reload(), 10000);</script>
      </body>
      </html>
    `);
  } else {
    res.end(`
      <!DOCTYPE html>
      <html>
      <head><title>Wasla Bot Starting...</title><meta charset="utf-8"></head>
      <body style="font-family: Arial; text-align: center; padding: 50px;">
        <h2>🔄 Starting Wasla WhatsApp Bot... Please refresh in 5 seconds.</h2>
        <script>setTimeout(() => location.reload(), 5000);</script>
      </body>
      </html>
    `);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Web interface active on port ${PORT}`);
});

// Self-Ping لمنع السيرفر من النوم على الباقة المجانية
setInterval(() => {
  const url = process.env.RENDER_EXTERNAL_URL || 'https://wasla-bot.onrender.com';
  console.log(`[Keep-Alive] Self-pinging ${url}...`);
  try {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      console.log(`[Keep-Alive] Ping response status: ${res.statusCode}`);
    }).on('error', (err) => {
      console.log(`[Keep-Alive] Ping error: ${err.message}`);
    });
  } catch (e) {}
}, 5 * 60 * 1000); // كل 5 دقائق

// Format Egyptian phone number
function formatWhatsAppNumber(phone) {
  if (!phone) return null;
  let cleaned = phone.replace(/[^0-9]/g, '');
  if (cleaned.startsWith('01') && cleaned.length === 11) {
    cleaned = '20' + cleaned.substring(1);
  } else if (cleaned.startsWith('0020')) {
    cleaned = cleaned.substring(2);
  } else if (!cleaned.startsWith('20') && cleaned.length === 10) {
    cleaned = '20' + cleaned;
  }
  return `${cleaned}@s.whatsapp.net`;
}

// Send WhatsApp Notification
async function sendOrderNotification(order) {
  if (!order || !order.id) return;
  
  if (processedOrders.has(String(order.id))) {
    return; // تلافي تكرار الإرسال
  }
  
  if (!sock || !sock.user) {
    console.error('[WhatsApp] Offline, holding notification for order:', order.id);
    return;
  }

  try {
    const shopId = order.shop_id;
    if (!shopId) {
      console.log('[Order] No shop_id associated with order:', order.id);
      return;
    }

    const { data: shop, error: shopError } = await supabase
      .from('shops')
      .select('name, owner_phone, phone_numbers')
      .eq('id', shopId)
      .single();

    if (shopError || !shop) {
      console.error('[Order] Failed to fetch shop data:', shopId, shopError);
      return;
    }

    let merchantPhone = shop.owner_phone;
    if ((!merchantPhone || merchantPhone.trim() === '') && Array.isArray(shop.phone_numbers) && shop.phone_numbers.length > 0) {
      merchantPhone = shop.phone_numbers[0];
    }

    if (!merchantPhone) {
      console.log(`[Order] Shop "${shop.name}" has no registered merchant phone.`);
      return;
    }

    const recipientJid = formatWhatsAppNumber(merchantPhone);
    if (!recipientJid) {
      console.log(`[Order] Invalid phone number for shop "${shop.name}":`, merchantPhone);
      return;
    }

    const orderIdShort = String(order.id).substring(0, 8);
    const totalAmount = order.total_amount || order.total || 0;
    const customerName = order.customer_name || 'عميل وصلة';
    const customerPhone = order.customer_phone || 'غير محدد';
    const address = order.address || order.delivery_address || 'استلام من الفرع / حسب العنوان';

    const messageText = 
`🔔 *طلب جديد في تطبيق وصلة!*
---------------------------------
🏬 *المتجر:* ${shop.name}
📦 *رقم الطلب:* #${orderIdShort}
👤 *العميل:* ${customerName}
📞 *رقم العميل:* ${customerPhone}
💰 *إجمالي المبلغ:* ${totalAmount} ج.م
📍 *العنوان:* ${address}
---------------------------------
⚡ *يرجى فتح تطبيق (وصلة أدمن) فوراً لمتابعة وتلبية الطلب 🚀*`;

    console.log(`[WhatsApp] Sending notification to "${shop.name}" (${merchantPhone})...`);

    await sock.sendMessage(recipientJid, { text: messageText });
    processedOrders.add(String(order.id));
    console.log(`[SUCCESS] WhatsApp notification sent for Order #${orderIdShort}!`);

  } catch (e) {
    console.error('[ERROR] Failed to send WhatsApp notification:', e);
  }
}

// Polling Backup: فحص دوري للطلبات الأخيرة كل 20 ثانية للتأكد من عدم تفويت أي طلب
async function checkRecentOrders() {
  if (!sock || !sock.user) return;
  try {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { data: recentOrders, error } = await supabase
      .from('orders')
      .select('*')
      .gte('created_at', tenMinutesAgo)
      .order('created_at', { ascending: false });

    if (!error && recentOrders && recentOrders.length > 0) {
      for (const order of recentOrders) {
        if (!processedOrders.has(String(order.id))) {
          console.log(`[Polling] Found recent unnotified order #${order.id}, sending...`);
          await sendOrderNotification(order);
        }
      }
    }
  } catch (e) {
    console.error('[Polling] Error checking recent orders:', e);
  }
}

// Connect Baileys Client
async function connectToWhatsApp() {
  const authDir = path.join(__dirname, 'auth_info_baileys');
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: 'silent' }),
    browser: ['WASLA Bot', 'Chrome', '1.0.0']
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        currentQRCodeDataURL = await QRCode.toDataURL(qr);
      } catch (e) {}
      console.log('\n==================================================');
      console.log('Scan the QR Code below using WhatsApp Business (01017323187):');
      console.log('==================================================\n');
      qrcodeTerminal.generate(qr, { small: true });
    }

    if (connection === 'close') {
      currentQRCodeDataURL = '';
      const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
      console.log('[WhatsApp] Connection closed. Reconnecting...', shouldReconnect);
      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 3000);
      } else {
        console.log('[WhatsApp] Logged out. Please scan QR code again.');
      }
    } else if (connection === 'open') {
      currentQRCodeDataURL = '';
      console.log('\n==================================================');
      console.log('SUCCESS: WhatsApp Business Connected! Bot is ACTIVE & ONLINE.');
      console.log('==================================================\n');
      startSupabaseListener();
      checkRecentOrders();
      setInterval(checkRecentOrders, 20 * 1000); // استطلاع تكميلي كل 20 ثانية
    }
  });
}

// Listen to Supabase Realtime
function startSupabaseListener() {
  console.log('[Supabase] Listening for NEW ORDERS (Realtime)...');

  supabase
    .channel('orders-realtime-channel')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'orders' },
      async (payload) => {
        console.log('\n[NEW ORDER RECEIVED]:', payload.new.id);
        await sendOrderNotification(payload.new);
      }
    )
    .subscribe((status) => {
      console.log('[Supabase Realtime Status]:', status);
    });
}

// Start bot
connectToWhatsApp();
