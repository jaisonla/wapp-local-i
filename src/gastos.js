/* Controle de gastos da casa.
   Escuta o grupo GRUPO_GASTOS, guarda cada mensagem (texto, áudio, foto com legenda, edição) em
   dados/gastos-mensagens.jsonl e transcreve os áudios pela Groq, respondendo no grupo com o texto.
   O Claude lê o registro pelo conector MCP (ler_mensagens_gastos) e confirma a leitura
   (confirmar_leitura_gastos) depois de lançar os gastos no dashboard.

   Pensado para rodar num celular antigo: nada de processamento local de áudio. O arquivo do
   WhatsApp (opus, poucos KB) vai direto para a Groq, um áudio por vez. */
import fs from 'node:fs';
import path from 'node:path';
import { downloadMediaMessage, normalizeMessageContent, getContentType } from 'baileys';
import { config } from './config.js';
import * as agenda from './agenda.js';
import { foiEnviadaPeloScript } from './enviadas.js';

const PASTA = process.env.PASTA_DADOS || 'dados';
const ARQ = path.join(PASTA, 'gastos-mensagens.jsonl');
const ARQ_ESTADO = path.join(PASTA, 'gastos-estado.json');
const JANELA_SEG = 24 * 60 * 60;        // ignora mensagens com mais de 24 h (histórico reenviado)
const URL_GROQ = 'https://api.groq.com/openai/v1/audio/transcriptions';
fs.mkdirSync(PASTA, { recursive: true });

export const ativo = () => !!config.grupoGastos;

/* ---------- registro ---------- */
let estado = { ultimoSeq: 0, lidoAte: 0 };
try { estado = { ...estado, ...JSON.parse(fs.readFileSync(ARQ_ESTADO, 'utf8')) }; } catch {}
const vistos = new Set();               // ids já registrados ou em processamento

(function carregar() {
  try {
    const linhas = fs.readFileSync(ARQ, 'utf8').split('\n').filter(Boolean);
    for (const l of linhas.slice(-3000)) {
      try { const r = JSON.parse(l); vistos.add(r.id); estado.ultimoSeq = Math.max(estado.ultimoSeq, r.seq || 0); } catch {}
    }
  } catch {}
})();

function salvarEstado() {
  fs.writeFileSync(ARQ_ESTADO + '.tmp', JSON.stringify(estado));
  fs.renameSync(ARQ_ESTADO + '.tmp', ARQ_ESTADO);
}

function gravar(reg) {
  const r = { seq: ++estado.ultimoSeq, ...reg, registrado: new Date().toISOString() };
  fs.appendFileSync(ARQ, JSON.stringify(r) + '\n');
  salvarEstado();
  return r;
}

/** Mensagens registradas depois de `desde` (padrão: as ainda não confirmadas). */
export function lerMensagens({ desde, limite = 200 } = {}) {
  const corte = desde ?? estado.lidoAte;
  let lista = [];
  try {
    lista = fs.readFileSync(ARQ, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(r => r && r.seq > corte);
  } catch {}
  const pendentes = filaAudios;
  return {
    grupo: config.grupoGastos, lidoAte: estado.lidoAte, ultimoSeq: estado.ultimoSeq,
    audiosEmProcessamento: pendentes, total: lista.length, mensagens: lista.slice(0, limite)
  };
}

/** Marca como lidas todas as mensagens até `ateSeq`. */
export function confirmarLeitura(ateSeq) {
  const n = Math.floor(Number(ateSeq));
  if (!Number.isFinite(n) || n < 0) throw new Error('Informe ate_seq, o seq da última mensagem já lançada.');
  if (n > estado.ultimoSeq) throw new Error(`ate_seq (${n}) é maior que o último registro (${estado.ultimoSeq}).`);
  estado.lidoAte = Math.max(estado.lidoAte, n);
  salvarEstado();
  return { lidoAte: estado.lidoAte, ultimoSeq: estado.ultimoSeq };
}

/* ---------- quem mandou ---------- */
const numeroLimpo = jid => jid && jid.endsWith('@s.whatsapp.net') ? jid.split('@')[0].split(':')[0] : null;

function autorDe(m, sock) {
  const k = m.key || {};
  let numero = null;
  if (k.fromMe) numero = numeroLimpo((sock.user?.id || '').replace(/:\d+@/, '@')) || config.numeroRobo || null;
  else {
    for (const c of [k.participantAlt, k.participant, m.participant].filter(Boolean)) {
      numero = numeroLimpo(c) || agenda.porId(c)?.numero || null;
      if (numero) break;
    }
  }
  const nome = (numero && config.pessoasGastos.get(agenda.chaveNumero(numero)))
    || m.pushName || (numero && agenda.nomeDe(agenda.porNumero(numero))) || (numero ? '+' + numero : 'Desconhecido');
  return { autor: nome, numero };
}

/* ---------- conteúdo ---------- */
function extrair(m) {
  const c = normalizeMessageContent(m.message);
  if (!c) return null;
  const tipo = getContentType(c);
  const ctx = c[tipo]?.contextInfo;
  const base = { respondendo: ctx?.stanzaId || null };
  switch (tipo) {
    case 'conversation': return { ...base, tipo: 'texto', texto: c.conversation };
    case 'extendedTextMessage': return { ...base, tipo: 'texto', texto: c.extendedTextMessage.text };
    case 'audioMessage': return { ...base, tipo: 'audio', duracaoSeg: c.audioMessage.seconds || null, mimetype: c.audioMessage.mimetype || 'audio/ogg' };
    case 'imageMessage': return { ...base, tipo: 'imagem', texto: c.imageMessage.caption || '' };
    case 'documentMessage': return { ...base, tipo: 'documento', texto: c.documentMessage.caption || c.documentMessage.fileName || '' };
    case 'protocolMessage': {
      const p = c.protocolMessage;
      if (p.editedMessage) {
        const e = normalizeMessageContent(p.editedMessage);
        return { tipo: 'edicao', respondendo: p.key?.id || null, texto: e?.conversation || e?.extendedTextMessage?.text || '' };
      }
      if (p.type === 0) return { tipo: 'apagada', respondendo: p.key?.id || null, texto: '' };
      return null;
    }
    default: return null;   // reações, figurinhas, chaves de criptografia etc.
  }
}

/* ---------- transcrição ---------- */
const espera = ms => new Promise(r => setTimeout(r, ms));

export async function transcrever(buffer, mimetype) {
  if (!config.groqKey) throw new Error('GROQ_API_KEY não configurada');
  let ultimoErro;
  for (const atraso of [0, 2000, 6000]) {
    if (atraso) await espera(atraso);
    try {
      const fd = new FormData();
      fd.append('file', new Blob([buffer], { type: (mimetype || 'audio/ogg').split(';')[0] }), 'audio.ogg');
      fd.append('model', config.groqModelo);
      fd.append('language', 'pt');
      fd.append('temperature', '0');
      fd.append('response_format', 'json');
      fd.append('prompt', 'Gastos da casa em reais: mercado, gasolina, farmácia, pix, cartão de crédito, débito, boleto.');
      const r = await fetch(URL_GROQ, { method: 'POST', headers: { Authorization: `Bearer ${config.groqKey}` }, body: fd, signal: AbortSignal.timeout(30000) });
      if (r.ok) return String((await r.json()).text || '').trim();
      const corpo = (await r.text()).slice(0, 200);
      ultimoErro = new Error(`Groq ${r.status}: ${corpo}`);
      if (r.status < 500 && r.status !== 429) break;   // erro de chave ou de pedido: não adianta repetir
    } catch (e) { ultimoErro = e; }
  }
  throw ultimoErro;
}

let fila = Promise.resolve();
let filaAudios = 0;

function processarAudio(m, sock, reg, enviar) {
  filaAudios++;
  fila = fila.then(async () => {
    let transcricao = null, erro = null;
    try {
      if (reg.duracaoSeg && reg.duracaoSeg > config.audioMaxSeg) {
        erro = `áudio com ${reg.duracaoSeg} s, acima do limite de ${config.audioMaxSeg} s`;
      } else {
        const buffer = await downloadMediaMessage(m, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
        transcricao = await transcrever(buffer, reg.mimetype);
        if (!transcricao) erro = 'transcrição vazia';
      }
    } catch (e) { erro = e.message || String(e); }

    const { mimetype, ...sem } = reg;
    gravar({ ...sem, transcricao, erro });
    console.log(`[gastos] áudio de ${reg.autor}: ${erro ? 'ERRO ' + erro : transcricao}`);

    if (!config.gastosResponder) return;
    let texto;
    if (transcricao) texto = `🎙️ *${reg.autor}:* "${transcricao}"`;
    else if (reg.duracaoSeg && reg.duracaoSeg > config.audioMaxSeg) texto = `🎙️ Áudio longo demais (mais de ${Math.round(config.audioMaxSeg / 60)} min). Manda em partes, por favor.`;
    else if (!config.groqKey) return;
    else texto = '🎙️ Não consegui transcrever esse áudio. Pode mandar de novo ou em texto?';
    try { await enviar({ para: config.grupoGastos, texto, citar: m }); }
    catch (e) { console.error('[gastos] falha ao responder:', e.message); }
  }).catch(e => console.error('[gastos]', e)).finally(() => { filaAudios--; });
}

/* ---------- ligação com o socket ---------- */
export function ouvir(sock, { enviar }) {
  if (!ativo()) return;
  sock.ev.on('messages.upsert', ({ messages = [] }) => {
    for (const m of messages) {
      try {
        const k = m.key || {};
        if (k.remoteJid !== config.grupoGastos || !k.id) continue;
        if (vistos.has(k.id)) continue;
        if (k.fromMe && foiEnviadaPeloScript(k.id)) continue;          // o próprio robô respondendo
        const ts = Number(m.messageTimestamp?.low ?? m.messageTimestamp ?? 0);
        if (ts && Date.now() / 1000 - ts > JANELA_SEG) continue;
        const conteudo = extrair(m);
        if (!conteudo) continue;
        vistos.add(k.id);
        const reg = { id: k.id, quando: new Date((ts || Date.now() / 1000) * 1000).toISOString(), ...autorDe(m, sock), ...conteudo };
        if (reg.tipo === 'audio') processarAudio(m, sock, reg, enviar);
        else gravar(reg);
      } catch (e) { console.error('[gastos] mensagem ignorada:', e.message); }
    }
  });
  console.log(`[gastos] ouvindo o grupo ${config.grupoGastos}${config.groqKey ? ' (transcrição ligada)' : ' (sem GROQ_API_KEY: áudios só registrados)'}`);
}
