import 'dotenv/config';

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const lista = v => (v || '').split(',').map(s => s.trim()).filter(Boolean);

export const config = {
  porta: num(process.env.PORT, 3000),
  apiToken: process.env.API_TOKEN || '',
  mcpSegredo: process.env.MCP_SEGREDO || '',
  painelUsuario: process.env.PAINEL_USUARIO || 'jaison',
  painelSenha: process.env.PAINEL_SENHA || '',
  numeroRobo: (process.env.NUMERO_ROBO || '').replace(/\D/g, ''),
  intervaloMin: num(process.env.INTERVALO_MIN_MS, 2500),
  intervaloMax: num(process.env.INTERVALO_MAX_MS, 6000),
  limiteDia: num(process.env.LIMITE_DIA, 200),
  destinosPermitidos: lista(process.env.DESTINOS_PERMITIDOS),
  exigirConhecido: /^(1|true|sim)$/i.test(process.env.EXIGIR_CONVERSA_EXISTENTE || ''),
  linkPainel: process.env.LINK_PAINEL || 'https://web.jaison.eng.br/conectar',
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChat: process.env.TELEGRAM_CHAT_ID || '',
  pastaSessao: process.env.PASTA_SESSAO || 'sessao',
  pastaLogs: process.env.PASTA_LOGS || 'logs'
};

export function validarConfig() {
  const faltando = [];
  if (config.apiToken.length < 24) faltando.push('API_TOKEN (mínimo 24 caracteres)');
  if (config.mcpSegredo.length < 24) faltando.push('MCP_SEGREDO (mínimo 24 caracteres)');
  if (config.painelSenha.length < 10) faltando.push('PAINEL_SENHA (mínimo 10 caracteres)');
  if (faltando.length) {
    console.error('\nConfiguração incompleta no arquivo .env:\n - ' + faltando.join('\n - ') +
      '\nRode "npm run configurar" para gerar os segredos automaticamente.\n');
    process.exit(1);
  }
}
