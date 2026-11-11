/* Baixa um arquivo a partir de um link, para enviar pelo WhatsApp sem passar o conteúdo pelo conector.
   Pensado para uma "caixa de saída" num repositório privado do GitHub, lida com um token só de leitura. */
import path from 'node:path';
import { config } from './config.js';

const GITHUB = new Set(['github.com', 'raw.githubusercontent.com', 'api.github.com']);

/** Converte links do GitHub (página, raw ou API) para o endereço da API que entrega o arquivo bruto. */
function linkGithub(u) {
  const p = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (u.hostname === 'api.github.com') return u;
  let dono, repo, ref, resto;
  if (u.hostname === 'github.com') {                 // /dono/repo/blob/ref/caminho  ou  /dono/repo/raw/ref/caminho
    if (!['blob', 'raw'].includes(p[2])) throw new Error('Link do GitHub inválido: use o link do arquivo (…/blob/main/pasta/arquivo.pdf).');
    [dono, repo, , ref, ...resto] = p;
  } else {                                           // raw.githubusercontent.com/dono/repo/ref/caminho
    [dono, repo, ref, ...resto] = p;
  }
  if (!dono || !repo || !ref || !resto.length) throw new Error('Link do GitHub incompleto.');
  const api = new URL(`https://api.github.com/repos/${dono}/${repo}/contents/${resto.map(encodeURIComponent).join('/')}`);
  api.searchParams.set('ref', ref);
  return api;
}

export async function baixarArquivo(link) {
  let u;
  try { u = new URL(String(link || '').trim()); } catch { throw new Error('Link do arquivo inválido.'); }
  if (u.protocol !== 'https:') throw new Error('O link do arquivo precisa começar com https://');
  const hosts = new Set([...GITHUB, ...config.hostsArquivos]);
  if (!hosts.has(u.hostname)) throw new Error(`Site não permitido para baixar arquivos: ${u.hostname}. Permitidos: ${[...hosts].join(', ')}.`);

  const nomeOriginal = path.basename(decodeURIComponent(u.pathname)) || 'arquivo';
  const headers = { 'user-agent': 'wapp-local' };
  if (GITHUB.has(u.hostname)) {
    u = linkGithub(u);
    headers.accept = 'application/vnd.github.raw';
    headers['x-github-api-version'] = '2022-11-28';
    if (config.githubToken) headers.authorization = `Bearer ${config.githubToken}`;
  }

  const limite = config.limiteArquivoMb * 1024 * 1024;
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 120000);
  let r;
  try { r = await fetch(u, { headers, redirect: 'follow', signal: ctrl.signal }); }
  catch (e) { clearTimeout(t); throw new Error(`Não foi possível baixar o arquivo: ${e.name === 'AbortError' ? 'tempo esgotado' : e.message}.`); }
  if (!r.ok) {
    clearTimeout(t);
    const dica = r.status === 404 ? ' Confira o link e se o GITHUB_TOKEN tem acesso a esse repositório.' : r.status === 401 ? ' O GITHUB_TOKEN está inválido ou expirou.' : '';
    throw new Error(`O servidor do arquivo respondeu ${r.status}.${dica}`);
  }
  const tam = Number(r.headers.get('content-length') || 0);
  if (tam > limite) { clearTimeout(t); throw new Error(`Arquivo de ${(tam / 1048576).toFixed(1)} MB passa do limite de ${config.limiteArquivoMb} MB.`); }

  const partes = []; let total = 0;
  for await (const parte of r.body) {
    total += parte.length;
    if (total > limite) { ctrl.abort(); clearTimeout(t); throw new Error(`Arquivo passa do limite de ${config.limiteArquivoMb} MB.`); }
    partes.push(parte);
  }
  clearTimeout(t);
  const buffer = Buffer.concat(partes);
  if (!buffer.length) throw new Error('O arquivo baixado está vazio.');
  const tipo = (r.headers.get('content-type') || '').split(';')[0].trim();
  return { buffer, nome: nomeOriginal, mimetype: tipo && !/octet-stream|vnd\.github|text\/plain/.test(tipo) ? tipo : null };
}
