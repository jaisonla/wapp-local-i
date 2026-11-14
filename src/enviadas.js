/* Ids das mensagens que o próprio script enviou. Servem para o controle de gastos ignorar
   só o que o robô escreveu sozinho, e não o que alguém digitou ou gravou à mão no número dele. */
import fs from 'node:fs';
import path from 'node:path';

const PASTA = process.env.PASTA_DADOS || 'dados';
const ARQ = path.join(PASTA, 'enviadas.json');
const MAX = 500;
fs.mkdirSync(PASTA, { recursive: true });

let ids = [];
try { ids = JSON.parse(fs.readFileSync(ARQ, 'utf8')); if (!Array.isArray(ids)) ids = []; } catch {}
const conjunto = new Set(ids);

let timer = null;
function salvar() {
  clearTimeout(timer);
  timer = setTimeout(() => fs.writeFile(ARQ + '.tmp', JSON.stringify(ids), e => { if (!e) fs.rename(ARQ + '.tmp', ARQ, () => {}); }), 1000);
}

export function registrarEnviada(id) {
  if (!id || conjunto.has(id)) return;
  ids.push(id); conjunto.add(id);
  while (ids.length > MAX) conjunto.delete(ids.shift());
  salvar();
}

export const foiEnviadaPeloScript = id => !!id && conjunto.has(id);
