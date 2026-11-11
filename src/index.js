import express from 'express';
import crypto from 'node:crypto';
import { config, validarConfig } from './config.js';
import { estado, iniciar, novaSessao, codigoPareamento, enviar, listarGrupos, conferirDestino, listarConversas, buscarContato, contagemAgenda } from './whatsapp.js';
import { tratarMcp } from './mcp.js';
import { paginaPainel } from './painel.js';

validarConfig();

const igual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
app.use(express.json({ limit: '25mb' }));
app.use((req, res, next) => { res.set('X-Robots-Tag', 'noindex, nofollow'); next(); });

/* ---------- painel de conexão (senha + Cloudflare Access na frente) ---------- */
function senhaPainel(req, res, next) {
  const h = req.headers.authorization || '';
  const [tipo, val] = h.split(' ');
  if (tipo === 'Basic' && val) {
    const [u, ...p] = Buffer.from(val, 'base64').toString().split(':');
    if (igual(u, config.painelUsuario) && igual(p.join(':'), config.painelSenha)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Conexao do WhatsApp", charset="UTF-8"').status(401).send('Acesso restrito.');
}
app.get('/conectar', senhaPainel, (req, res) => res.type('html').send(paginaPainel));
app.get('/conectar/estado', senhaPainel, (req, res) => res.json({
  status: estado.status, desde: estado.desde, conta: estado.conta, qrDataUrl: estado.qrDataUrl,
  ultimoErro: estado.ultimoErro, enviosHoje: estado.enviosHoje, limiteDia: config.limiteDia, numeroRobo: config.numeroRobo, agenda: contagemAgenda()
}));
app.post('/conectar/codigo', senhaPainel, async (req, res) => {
  try { res.json({ codigo: await codigoPareamento(req.body?.numero) }); }
  catch (e) { res.status(400).json({ erro: e.message }); }
});
app.post('/conectar/nova-sessao', senhaPainel, async (req, res) => { await novaSessao(); res.json({ ok: true }); });

/* ---------- API com token ---------- */
function token(req, res, next) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ') && igual(h.slice(7), config.apiToken)) return next();
  res.status(401).json({ erro: 'Token inválido ou ausente.' });
}
app.get('/api/status', token, (req, res) => res.json({ status: estado.status, desde: estado.desde, conta: estado.conta, enviosHoje: estado.enviosHoje, filaPendente: estado.filaPendente }));
app.get('/api/grupos', token, async (req, res) => {
  try { res.json(await listarGrupos(req.query.filtro)); } catch (e) { res.status(409).json({ erro: e.message }); }
});
app.get('/api/conversas', token, (req, res) => res.json({ total: contagemAgenda(), conversas: listarConversas({ tipo: req.query.tipo, limite: Math.min(500, Number(req.query.limite) || 50) }) }));
app.get('/api/buscar', token, (req, res) => res.json(buscarContato(String(req.query.q || ''), { tipo: req.query.tipo, limite: 10 })));
app.get('/api/conferir', token, async (req, res) => res.json(await conferirDestino(req.query.para)));
app.post('/api/enviar', token, async (req, res) => {
  const b = req.body || {};
  try {
    res.json({ enviado: true, ...(await enviar({ para: b.para, texto: b.texto, arquivoBase64: b.arquivo_base64, nomeArquivo: b.nome_arquivo, legenda: b.legenda, mimetype: b.mimetype })) });
  } catch (e) { res.status(400).json({ enviado: false, erro: e.message, candidatos: e.candidatos || undefined }); }
});

/* ---------- conector MCP: segredo na URL ---------- */
app.post('/mcp/:segredo', (req, res, next) => igual(req.params.segredo, config.mcpSegredo) ? tratarMcp(req, res) : res.status(404).end());
app.all('/mcp/:segredo', (req, res) => res.status(405).set('Allow', 'POST').end());

app.get('/', (req, res) => res.type('text').send('ok'));
app.use((req, res) => res.status(404).type('text').send('Não encontrado.'));
app.use((err, req, res, next) => { console.error(err); res.status(err.status || 500).json({ erro: err.type === 'entity.too.large' ? 'Arquivo grande demais (máx. 25 MB em base64).' : 'Erro interno.' }); });

app.listen(config.porta, '127.0.0.1', () => {
  console.log(`[servidor] ouvindo em http://127.0.0.1:${config.porta}`);
  iniciar().catch(e => console.error('[whatsapp] falha ao iniciar:', e));
});

for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { console.log('[servidor] encerrando'); process.exit(0); });
