/* Agenda local: conversas e grupos que o WhatsApp do robô conhece, montada a partir dos eventos do Baileys
   (sincronização inicial, conversas novas, nomes de contato) e de um contatos.csv opcional.
   Fica salva em dados/conversas.json para sobreviver a reinícios. */
import fs from 'node:fs';
import path from 'node:path';

const PASTA = process.env.PASTA_DADOS || 'dados';
const ARQ = path.join(PASTA, 'conversas.json');
const CSV = path.join(PASTA, 'contatos.csv');
fs.mkdirSync(PASTA, { recursive: true });

const itens = new Map();     // id canônico → registro
const apelidos = new Map();  // @lid → id canônico (@s.whatsapp.net)
let manuais = new Map();     // número → nome vindo do contatos.csv

/* ---------- utilidades ---------- */
export const normalizar = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const digitos = s => String(s || '').replace(/\D/g, '');
const ignorar = id => !id || id === 'status@broadcast' || id.endsWith('@newsletter') || id.endsWith('@broadcast');
const ehGrupo = id => id.endsWith('@g.us');
const numeroDe = id => (id && id.endsWith('@s.whatsapp.net')) ? id.split('@')[0].split(':')[0] : null;
const segundos = v => { const n = Number(v?.low ?? v ?? 0); return n > 1e12 ? Math.round(n / 1000) : n; };
/** Chave que ignora o nono dígito: DDI + DDD + últimos 8 dígitos. */
export const chaveNumero = n => { const d = digitos(n); return d.length >= 12 ? d.slice(0, 4) + d.slice(-8) : d; };

export function nomeDe(r) {
  if (!r) return null;
  return manuais.get(chaveNumero(r.numero))?.nome || r.nomeAgenda || r.nomeGrupo || r.nomeProprio || (r.numero ? '+' + r.numero : r.id);
}

/* ---------- gravação ---------- */
let timer = null;
function salvar() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const dados = { atualizado: new Date().toISOString(), itens: [...itens.values()], apelidos: Object.fromEntries(apelidos) };
    fs.writeFile(ARQ + '.tmp', JSON.stringify(dados), e => { if (!e) fs.rename(ARQ + '.tmp', ARQ, () => {}); });
  }, 2000);
}
export function carregar() {
  try {
    const d = JSON.parse(fs.readFileSync(ARQ, 'utf8'));
    d.itens.forEach(r => itens.set(r.id, r));
    Object.entries(d.apelidos || {}).forEach(([a, b]) => apelidos.set(a, b));
  } catch {}
  carregarCsv();
  try { fs.watchFile(CSV, { interval: 5000 }, carregarCsv); } catch {}
  console.log(`[agenda] ${itens.size} conversas carregadas, ${manuais.size} contatos manuais`);
}
function carregarCsv() {
  const m = new Map();
  try {
    fs.readFileSync(CSV, 'utf8').split(/\r?\n/).forEach((linha, i) => {
      const [nome, numero] = linha.split(/[;,\t]/).map(s => (s || '').trim());
      if (!nome || !numero || (i === 0 && /nome/i.test(nome))) return;
      let n = digitos(numero); if (n.length === 10 || n.length === 11) n = '55' + n;
      if (n.length >= 12) m.set(chaveNumero(n), { nome, numero: n });
    });
  } catch {}
  manuais = m;
  for (const [chave, c] of m) if (!porNumero(chave)) registrar(c.numero + '@s.whatsapp.net', { fonte: 'contatos.csv' });
}

/* ---------- atualização ---------- */
function canonico(id) { return apelidos.get(id) || id; }

export function vincularLid(lid, pn) {
  if (!lid || !pn || !lid.endsWith('@lid') || !pn.endsWith('@s.whatsapp.net')) return;
  pn = pn.split(':')[0].split('@')[0] + '@s.whatsapp.net';
  apelidos.set(lid, pn);
  const antigo = itens.get(lid);
  if (antigo) { itens.delete(lid); registrar(pn, { ...antigo, id: pn, numero: numeroDe(pn), lid }); }
  else { const r = itens.get(pn); if (r) r.lid = lid; }
  salvar();
}

export function registrar(idBruto, dados = {}) {
  if (ignorar(idBruto)) return null;
  const id = canonico(idBruto.includes(':') && !ehGrupo(idBruto) ? idBruto.replace(/:\d+@/, '@') : idBruto);
  const r = itens.get(id) || { id, tipo: ehGrupo(id) ? 'grupo' : 'pessoa', numero: numeroDe(id), lid: id.endsWith('@lid') ? id : null, ultimaAtividade: 0 };
  for (const [k, v] of Object.entries(dados)) {
    if (v === undefined || v === null || v === '') continue;
    if (k === 'ultimaAtividade') r.ultimaAtividade = Math.max(r.ultimaAtividade || 0, segundos(v));
    else if (k !== 'id') r[k] = v;
  }
  itens.set(id, r); salvar(); return r;
}

/** Liga a agenda aos eventos do socket do Baileys. */
export function ouvir(sock) {
  const ev = sock.ev;
  ev.on('messaging-history.set', ({ chats = [], contacts = [], lidPnMappings = [] }) => {
    lidPnMappings.forEach(m => vincularLid(m.lid, m.pn));
    contacts.forEach(contato);
    chats.forEach(conversa);
    console.log(`[agenda] sincronização: ${chats.length} conversas, ${contacts.length} contatos (total ${itens.size})`);
  });
  ev.on('chats.upsert', l => l.forEach(conversa));
  ev.on('chats.update', l => l.forEach(conversa));
  ev.on('contacts.upsert', l => l.forEach(contato));
  ev.on('contacts.update', l => l.forEach(contato));
  ev.on('lid-mapping.update', m => vincularLid(m.lid, m.pn));
  ev.on('groups.upsert', l => l.forEach(g => registrar(g.id, { nomeGrupo: g.subject })));
  ev.on('groups.update', l => l.forEach(g => g.id && registrar(g.id, { nomeGrupo: g.subject })));
  ev.on('messages.upsert', ({ messages = [] }) => messages.forEach(m => {
    const k = m.key || {}; const chat = k.remoteJid; if (ignorar(chat)) return;
    if (k.remoteJidAlt) vincularLid(chat, k.remoteJidAlt);
    registrar(chat, { ultimaAtividade: m.messageTimestamp });
    if (!k.fromMe && m.pushName) {
      const autor = ehGrupo(chat) ? (k.participantAlt || k.participant) : (k.remoteJidAlt || chat);
      if (autor && !ehGrupo(autor)) registrar(autor, { nomeProprio: m.pushName });
    }
  }));
}
function contato(c) {
  if (!c?.id) return;
  if (c.lid && c.phoneNumber) vincularLid(c.lid, c.phoneNumber);
  const id = c.phoneNumber || c.id;
  registrar(id, { nomeAgenda: c.name, nomeProprio: c.notify || c.verifiedName });
}
function conversa(ch) {
  if (!ch?.id) return;
  if (ch.lidJid && ch.pnJid) vincularLid(ch.lidJid, ch.pnJid);
  const id = ch.pnJid || ch.id;
  registrar(id, {
    ultimaAtividade: ch.conversationTimestamp || ch.lastMessageRecvTimestamp,
    nomeGrupo: ehGrupo(id) ? ch.name || ch.subject : undefined,
    nomeAgenda: !ehGrupo(id) ? ch.name : undefined,
    nomeProprio: ch.displayName, naoLidas: ch.unreadCount ?? undefined
  });
}

/* ---------- consulta ---------- */
export function porId(id) { return itens.get(canonico(id)) || null; }
export function porNumero(n) {
  const c = chaveNumero(n);
  for (const r of itens.values()) if (r.numero && chaveNumero(r.numero) === c) return r;
  return null;
}
export function nomeManual(n) { return manuais.get(chaveNumero(n))?.nome || null; }

export function resumo(r) {
  return { nome: nomeDe(r), tipo: r.tipo, numero: r.numero || null, id: r.id,
    ultimaConversa: r.ultimaAtividade ? new Date(r.ultimaAtividade * 1000).toISOString().slice(0, 10) : null };
}

export function listar({ tipo, limite = 30, busca } = {}) {
  let l = [...itens.values()].filter(r => !tipo || r.tipo === tipo);
  if (busca) return buscar(busca, { tipo, limite });
  return l.sort((a, b) => (b.ultimaAtividade || 0) - (a.ultimaAtividade || 0)).slice(0, limite).map(resumo);
}
export function contagem() {
  let p = 0, g = 0; for (const r of itens.values()) r.tipo === 'grupo' ? g++ : p++;
  return { pessoas: p, grupos: g, manuais: manuais.size };
}

function lev(a, b) {
  if (a === b) return 0; if (!a.length) return b.length; if (!b.length) return a.length;
  let v = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const w = [i];
    for (let j = 1; j <= b.length; j++) w[j] = Math.min(v[j] + 1, w[j - 1] + 1, v[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    v = w;
  }
  return v[b.length];
}
const parecido = (a, b) => 1 - lev(a, b) / Math.max(a.length, b.length);

/** Nota de 0 a 1 de quanto `nome` corresponde à busca `q` (ambos já normalizados). */
function nota(q, nome) {
  if (!nome) return 0;
  if (nome === q) return 1;
  if ((' ' + nome + ' ').includes(' ' + q + ' ')) return 0.92;
  const tq = q.split(' '), tn = nome.split(' ');
  if (tq.every(t => tn.includes(t))) return 0.92;
  if (tq.every(t => tn.some(x => x.startsWith(t)))) return 0.86;
  const media = tq.reduce((s, t) => s + Math.max(...tn.map(x => parecido(t, x.slice(0, Math.max(t.length, x.length))))), 0) / tq.length;
  return Math.min(0.85, media * 0.85 + (parecido(q, nome) * 0.15));
}

export function buscar(termo, { tipo, limite = 8 } = {}) {
  const q = normalizar(termo), d = digitos(termo);
  const res = [];
  for (const r of itens.values()) {
    if (tipo && r.tipo !== tipo) continue;
    let s = 0;
    if (d.length >= 4 && d.length === String(termo).replace(/[\s+()-]/g, '').length && r.numero) {
      if (chaveNumero(r.numero) === chaveNumero(d)) s = 1; else if (r.numero.endsWith(d)) s = 0.9; else if (r.numero.includes(d)) s = 0.75;
    } else if (q) {
      s = Math.max(...[manuais.get(chaveNumero(r.numero))?.nome, r.nomeAgenda, r.nomeGrupo, r.nomeProprio].map(n => nota(q, normalizar(n))));
    }
    if (s >= 0.6) res.push({ r, s });
  }
  return res.sort((a, b) => b.s - a.s || (b.r.ultimaAtividade || 0) - (a.r.ultimaAtividade || 0))
    .slice(0, limite).map(({ r, s }) => ({ ...resumo(r), semelhanca: Math.round(s * 100) / 100 }));
}
