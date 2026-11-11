/* Cria o arquivo .env com segredos aleatórios. Não sobrescreve um .env existente. */
import fs from 'node:fs';
import crypto from 'node:crypto';

if (fs.existsSync('.env')) {
  console.log('Já existe um arquivo .env. Nada foi alterado.');
  process.exit(0);
}
const seg = n => crypto.randomBytes(n).toString('base64url');
const texto = fs.readFileSync('.env.exemplo', 'utf8')
  .replace('API_TOKEN=', `API_TOKEN=${seg(32)}`)
  .replace('MCP_SEGREDO=', `MCP_SEGREDO=${seg(32)}`)
  .replace('PAINEL_SENHA=', `PAINEL_SENHA=${seg(12)}`);
fs.writeFileSync('.env', texto);
const v = Object.fromEntries(texto.split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l)).map(l => [l.split('=')[0], l.slice(l.indexOf('=') + 1)]));
console.log(`
Arquivo .env criado. Guarde estes dados num lugar seguro:

  Painel:        https://web.jaison.eng.br/conectar
  Usuário:       ${v.PAINEL_USUARIO}
  Senha:         ${v.PAINEL_SENHA}

  Conector MCP:  https://web.jaison.eng.br/mcp/${v.MCP_SEGREDO}
  Token da API:  ${v.API_TOKEN}

Edite o .env para informar NUMERO_ROBO e, se quiser alertas, o Telegram.
`);
