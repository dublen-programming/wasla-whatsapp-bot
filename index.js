const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const path = require('path');

// === Supabase Config ===
const SUPABASE_URL = 'https://zdgtfeisltmdchzyvjvr.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpkZ3RmZWlzbHRtZGNoenl2anZyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjA0NTk4MDUsImV4cCI6MjA3NjAzNTgwNX0.LNV972swlR0FFR3s50-V3QzpwQQ8vEOj8UVYsddzns4';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

let sock = null;

// Format Egyptian phone number to WhatsApp international JID
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

// Function to send WhatsApp order notification to merchant
async function sendOrderNotification(order) {
  if (!sock) {
    console.error('[WhatsApp] Connection offline, cannot send notification for order:', order.id);
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
    console.log(`[SUCCESS] WhatsApp notification sent for Order #${orderIdShort}!`);

  } catch (e) {
    console.error('[ERROR] Failed to send WhatsApp notification:', e);
  }
}

// Connect Baileys WhatsApp Client
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

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n==================================================');
      console.log('Scan the QR Code below using WhatsApp Business (01017323187):');
      console.log('==================================================\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
      console.log('[WhatsApp] Connection closed. Reconnecting...', shouldReconnect);
      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 3000);
      } else {
        console.log('[WhatsApp] Logged out. Please scan QR code again.');
      }
    } else if (connection === 'open') {
      console.log('\n==================================================');
      console.log('SUCCESS: WhatsApp Business Connected! Bot is ACTIVE & ONLINE.');
      console.log('==================================================\n');
      startSupabaseListener();
    }
  });
}

// Listen to new orders in Supabase Realtime
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
