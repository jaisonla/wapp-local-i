import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import QRCode from 'qrcode';
import makeWASocket, {
  Browsers, DisconnectReason, fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore, useMultiFileAuthState
} from 'baileys';
import { config } from './config.js';
import { alertar } from './alerta.js';
import * as agenda from './agenda.js';
import { baixarArquivo } from './arquivos.js';

agenda.carregar();

const logger = pino({ level: process.env.LOG_BAILEYS || 'warn' });
fs.mkdirSync(config.pastaLogs, { recursive: true });

/* ---------- estado público ---------- */
export const estado = {
  status: 'iniciando',        // iniciando | aguardando_conexao | conectado | reconectando | desconectado
  desde: new Date().toISOString(),
  conta: null,                // { numero, nome }
  qr: null, qrDataUrl: null,
  ultimoErro: null,
  enviosHoje: 0, diaContagem: hoje(),
  filaPendente: 0
};
function hoje() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Porto_Velho' }); }
function mudar(status, extra = {}) { Object.assign(estado, { status, desde: new Date().toISOString() }, extra); }

let sock = null, tentativas = 0, timerQueda = null, iniciando = false;

/* ---------- conexão ---------- */
export async function iniciar() {
  if (iniciando) return; iniciando = true;
  try {
    const { state, saveCreds } = await useMultiFileAuthState(config.pastaSessao);
    let version;
    try { ({ version } = await Promise.race([fetchLatestBaileysVersion(), new Promise((_, r) => setTimeout(() => r(new Error('tempo')), 8000))])); }
    catch { version = undefined; }

    sock = makeWASocket({
      version,
      logger,
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      browser: Browsers.windows('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false
    });

    sock.ev.on('creds.update', saveCreds);
    agenda.ouvir(sock);
    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        estado.qr = qr;
        estado.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
        if (estado.status !== 'aguardando_conexao') mudar('aguardando_conexao');
      }
      if (connection === 'open') {
        tentativas = 0; clearTimeout(timerQueda); timerQueda = null;
        const id = sock.user?.id || '';
        mudar('conectado', { qr: null, qrDataUrl: null, ultimoErro: null,
          conta: { numero: id.split(':')[0].split('@')[0], nome: sock.user?.name || '' } });
        console.log(`[whatsapp] conectado como ${estado.conta.numero}`);
        cacheGrupos.quando = 0; listarGrupos().catch(() => {});
      }
      if (connection === 'close') {
        const codigo = lastDisconnect?.error?.output?.statusCode;
        const motivo = lastDisconnect?.error?.message || 'desconhecido';
        estado.ultimoErro = `${codigo || ''} ${motivo}`.trim();
        if (codigo === DisconnectReason.loggedOut) {
          mudar('desconectado', { conta: null });
          alertar(`a sessão foi encerrada no celular. Conecte de novo em ${config.linkPainel}`);
          await apagarSessao();
          agendar(3000);
        } else {
          mudar('reconectando');
          if (!timerQueda) timerQueda = setTimeout(() => {
            if (estado.status !== 'conectado') alertar(`fora do ar há mais de 3 minutos (${estado.ultimoErro}). Verifique em ${config.linkPainel}`);
          }, 3 * 60 * 1000);
          agendar(Math.min(60000, 2000 * 2 ** tentativas++));
        }
      }
    });
  } finally { iniciando = false; }
}

function agendar(ms) { setTimeout(() => iniciar().catch(e => { console.error('[whatsapp] falha ao iniciar:', e); agendar(15000); }), ms); }

async function apagarSessao() {
  try { sock?.end(undefined); } catch {}
  sock = null;
  fs.rmSync(config.pastaSessao, { recursive: true, force: true });
}

/** Encerra a sessão atual e gera um QR novo. */
export async function novaSessao() {
  try { await sock?.logout(); } catch {}
  await apagarSessao();
  mudar('reconectando', { conta: null, qr: null, qrDataUrl: null });
  agendar(500);
}

/** Código de 8 caracteres para "Conectar com número de telefone" no celular do robô. */
export async function codigoPareamento(numero) {
  const n = String(numero || config.numeroRobo).replace(/\D/g, '');
  if (n.length < 12) throw new Error('Informe o número com DDI e DDD, por exemplo 5569999990000.');
  if (estado.status === 'conectado') throw new Error('Já está conectado. Gere uma nova sessão antes de parear.');
  if (!sock) throw new Error('A conexão ainda está iniciando. Tente de novo em alguns segundos.');
  const c = await sock.requestPairingCode(n);
  return c.match(/.{1,4}/g).join('-');
}

/* ---------- destinos ---------- */
let cacheGrupos = { quando: 0, lista: [] };
export async function listarGrupos(filtro) {
  exigirConexao();
  if (Date.now() - cacheGrupos.quando > 5 * 60 * 1000) {
    const g = await sock.groupFetchAllParticipating();
    cacheGrupos = { quando: Date.now(), lista: Object.values(g).map(x => ({ id: x.id, nome: x.subject, participantes: x.participants?.length || 0 })) };
    cacheGrupos.lista.forEach(x => agenda.registrar(x.id, { nomeGrupo: x.nome }));
  }
  const f = (filtro || '').toLowerCase();
  return cacheGrupos.lista.filter(g => !f || g.nome.toLowerCase().includes(f)).sort((a, b) => a.nome.localeCompare(b.nome));
}

export class ErroDestino extends Error {
  constructor(msg, candidatos = []) { super(msg); this.candidatos = candidatos; }
}
const lista = c => c.map(x => `${x.nome}${x.numero ? ' (+' + x.numero + ')' : ''}`).join('; ');

/** Descobre para quem a mensagem vai, sem enviar. Lança ErroDestino com candidatos se houver dúvida. */
export async function resolverDestino(para) {
  const p = String(para || '').trim();
  if (!p) throw new ErroDestino('Informe o destino: número com DDD, nome da conversa ou do grupo.');
  if (/@(g\.us|s\.whatsapp\.net|lid)$/.test(p)) {
    const r = agenda.porId(p);
    return { jid: p, nome: r ? agenda.nomeDe(r) : p, tipo: p.endsWith('@g.us') ? 'grupo' : 'pessoa', numero: r?.numero || null, conhecido: !!r };
  }
  const soNumero = /^[\d\s+().-]+$/.test(p), d = p.replace(/\D/g, '');
  if (soNumero) {
    if (d.length < 10) {
      const c = d.length >= 4 ? agenda.buscar(d, { tipo: 'pessoa' }) : [];
      throw new ErroDestino(`Número incompleto (${d.length} dígitos). Informe DDD + número com 8 ou 9 dígitos.` +
        (c.length ? ` Conversas com "${d}" no número: ${lista(c)}.` : ''), c);
    }
    if (d.length > 13) throw new ErroDestino(`Número com dígitos demais (${d.length}). Informe DDI + DDD + número.`);
    exigirConexao();
    const n = d.length <= 11 ? '55' + d : d;
    const r = ((await sock.onWhatsApp(n)) || [])[0];
    if (!r?.exists) throw new ErroDestino(`O número +${n} não tem WhatsApp. Confira se não falta ou sobra algum dígito.`);
    const conhecido = agenda.porNumero(r.jid.split('@')[0]) || agenda.porNumero(n);
    const nome = conhecido ? agenda.nomeDe(conhecido) : agenda.nomeManual(n);
    return { jid: r.jid, nome: nome || '+' + n, tipo: 'pessoa', numero: r.jid.split('@')[0] || n, conhecido: !!conhecido };
  }
  const c = agenda.buscar(p, { limite: 6 });
  if (!c.length) throw new ErroDestino(`Nenhuma conversa ou grupo encontrado para "${p}". Use o número com DDD.`);
  const exatos = c.filter(x => x.semelhanca === 1);
  const fortes = c.filter(x => x.semelhanca >= 0.92);
  const unico = exatos.length === 1 ? exatos[0] : (!exatos.length && fortes.length === 1 && c.filter(x => x.semelhanca >= 0.75).length === 1 ? fortes[0] : null);
  if (!unico) throw new ErroDestino(`"${p}" não identifica uma única conversa com segurança. Candidatos: ${lista(c)}. Confirme qual é ou use o nome completo ou o número.`, c);
  let jid = unico.id;
  if (unico.tipo === 'pessoa' && unico.numero && estado.status === 'conectado' && sock) {
    const r = ((await sock.onWhatsApp(unico.numero)) || [])[0];
    if (!r?.exists) throw new ErroDestino(`${unico.nome} (+${unico.numero}) não tem WhatsApp. Confira o número no contatos.csv.`);
    jid = r.jid;
  }
  return { jid, nome: unico.nome, tipo: unico.tipo, numero: unico.numero, conhecido: true };
}

/** Versão para o Claude e a API: nunca lança, devolve o resultado da conferência. */
export async function conferirDestino(para) {
  try {
    const d = await resolverDestino(para);
    const r = agenda.porId(d.jid);
    return { resolvido: true, destino: { ...d, ultimaConversa: r?.ultimaAtividade ? new Date(r.ultimaAtividade * 1000).toISOString().slice(0, 10) : null },
      permitido: permitido(d.jid, d.nome),
      aviso: d.conhecido ? null : 'Este número não aparece nas conversas do robô. Confirme com o usuário antes de enviar.' };
  } catch (e) { return { resolvido: false, erro: e.message, candidatos: e.candidatos || [] }; }
}

export const listarConversas = opts => agenda.listar(opts);
export const buscarContato = (termo, opts) => agenda.buscar(termo, opts);
export const contagemAgenda = () => agenda.contagem();

function permitido(jid, rotulo) {
  const lista = config.destinosPermitidos;
  if (!lista.length) return true;
  const num = jid.split('@')[0];
  return lista.some(d => d === jid || d === num || d.replace(/\D/g, '') === num || d.toLowerCase() === String(rotulo).toLowerCase());
}

function exigirConexao() {
  if (estado.status !== 'conectado' || !sock) throw new Error(`WhatsApp não está conectado (status: ${estado.status}). Reconecte em ${config.linkPainel}`);
}

/* ---------- envio com fila e intervalo ---------- */
const MIME = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  mp4: 'video/mp4', mp3: 'audio/mpeg', ogg: 'audio/ogg', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', csv: 'text/csv', txt: 'text/plain', zip: 'application/zip' };

let fila = Promise.resolve();
const espera = ms => new Promise(r => setTimeout(r, ms));
const aleatorio = () => config.intervaloMin + Math.random() * Math.max(0, config.intervaloMax - config.intervaloMin);

export function enviar(pedido) {
  estado.filaPendente++;
  const tarefa = fila.then(() => enviarAgora(pedido)).finally(() => { estado.filaPendente--; });
  fila = tarefa.catch(() => {}).then(() => espera(aleatorio()));
  return tarefa;
}

async function enviarAgora({ para, texto, arquivoBase64, arquivoUrl, nomeArquivo, mimetype, legenda }) {
  exigirConexao();
  if (estado.diaContagem !== hoje()) { estado.diaContagem = hoje(); estado.enviosHoje = 0; }
  if (estado.enviosHoje >= config.limiteDia) throw new Error(`Limite diário de ${config.limiteDia} envios atingido.`);
  const dest = await resolverDestino(para);
  const { jid } = dest, rotulo = dest.nome;
  if (!permitido(jid, rotulo)) throw new Error(`Destino "${rotulo}" não está na lista DESTINOS_PERMITIDOS.`);
  if (config.exigirConhecido && !dest.conhecido) throw new Error(`"${rotulo}" não está nas conversas do robô e EXIGIR_CONVERSA_EXISTENTE está ativo.`);

  let conteudo;
  if (arquivoBase64 || arquivoUrl) {
    let buffer;
    if (arquivoUrl) {
      const b = await baixarArquivo(arquivoUrl);
      buffer = b.buffer; nomeArquivo = nomeArquivo || b.nome; mimetype = mimetype || b.mimetype;
    } else {
      const limpo = String(arquivoBase64).replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
      buffer = Buffer.from(limpo, 'base64');
      if (!buffer.length) throw new Error('O arquivo em base64 está vazio ou inválido.');
    }
    if (buffer.length > config.limiteArquivoMb * 1024 * 1024) throw new Error(`Arquivo maior que ${config.limiteArquivoMb} MB.`);
    const nome = nomeArquivo || 'arquivo';
    const tipo = mimetype || MIME[nome.split('.').pop().toLowerCase()] || 'application/octet-stream';
    const cap = legenda ?? texto ?? undefined;
    if (tipo.startsWith('image/') && tipo !== 'image/gif') conteudo = { image: buffer, caption: cap, mimetype: tipo };
    else if (tipo.startsWith('video/')) conteudo = { video: buffer, caption: cap, mimetype: tipo };
    else if (tipo.startsWith('audio/')) conteudo = { audio: buffer, mimetype: tipo };
    else conteudo = { document: buffer, mimetype: tipo, fileName: nome, caption: cap };
  } else {
    if (!texto || !String(texto).trim()) throw new Error('Informe o texto da mensagem.');
    conteudo = { text: String(texto) };
  }

  try { await sock.sendPresenceUpdate('composing', jid); await espera(800 + Math.random() * 1200); await sock.sendPresenceUpdate('paused', jid); } catch {}
  const r = await sock.sendMessage(jid, conteudo);
  estado.enviosHoje++;
  const registro = { quando: new Date().toISOString(), para: rotulo, numero: dest.numero, jid, conhecido: dest.conhecido, tipo: Object.keys(conteudo)[0], arquivo: nomeArquivo || null, tamanhoKb: conteudo.text ? undefined : Math.round((conteudo.document || conteudo.image || conteudo.video || conteudo.audio).length / 1024), id: r?.key?.id };
  fs.appendFile(path.join(config.pastaLogs, 'envios.jsonl'), JSON.stringify(registro) + '\n', () => {});
  return registro;
}
