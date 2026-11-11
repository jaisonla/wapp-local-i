import { config } from './config.js';

/* Avisos fora do WhatsApp (que pode ser justamente o que caiu).
   Hoje: console (vai para o log do PM2) e, se configurado, Telegram. */
let ultimo = { texto: '', quando: 0 };

export async function alertar(texto) {
  const agora = Date.now();
  if (texto === ultimo.texto && agora - ultimo.quando < 10 * 60 * 1000) return; // evita repetir em 10 min
  ultimo = { texto, quando: agora };
  console.warn(`[alerta] ${texto}`);
  if (!config.telegramToken || !config.telegramChat) return;
  try {
    await fetch(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: config.telegramChat, text: `WhatsApp do robô: ${texto}`, disable_web_page_preview: true })
    });
  } catch (e) {
    console.error('[alerta] não foi possível avisar pelo Telegram:', e.message);
  }
}
