import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { estado, enviar, listarGrupos, conferirDestino, listarConversas, buscarContato, contagemAgenda } from './whatsapp.js';
import { config } from './config.js';

const texto = obj => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
const erro = e => ({ isError: true, content: [{ type: 'text', text: (e.message || String(e)) + (e.candidatos?.length ? '\nCandidatos:\n' + JSON.stringify(e.candidatos, null, 2) : '') }] });

function caixa() {
  if (!config.caixaSaida) return null;
  const pasta = config.caixaPasta ? config.caixaPasta + '/' : '';
  return { repo: config.caixaSaida, pasta, exemplo: `https://github.com/${config.caixaSaida}/blob/main/${pasta}relatorio.pdf` };
}

function instrucoes() {
  const c = caixa();
  const arquivos = c
    ? `Arquivos com mais de uns 30 KB (PDF, planilhas, fotos): não use base64. Faça commit e push do arquivo no repositório privado do GitHub ${c.repo}, na pasta ${c.pasta || 'raiz'} e na branch main (se o repositório não estiver na sessão, adicione-o; ele pertence ao usuário), use um nome de arquivo sem espaços e chame enviar_arquivo_url com o link no formato ${c.exemplo}. Depois do envio, o arquivo pode ficar no repositório.`
    : 'Arquivos com mais de uns 30 KB: não use base64; use enviar_arquivo_url com um link https do arquivo (GitHub ou site liberado em HOSTS_ARQUIVOS).';
  return 'Envia mensagens de WhatsApp pelo número do robô de Jaison Alves. Antes de qualquer envio: 1) chame conferir_destino; ' +
    '2) se vier mais de um candidato ou aviso, pergunte ao usuário qual é o certo; 3) mostre ao usuário o nome e o número que o destino resolveu e o conteúdo, ' +
    'e só envie após confirmação, a menos que a tarefa já defina exatamente o destino e o conteúdo. Use buscar_contato e listar_conversas para achar pessoas e grupos. ' + arquivos;
}

function criarServidor() {
  const s = new McpServer(
    { name: 'whatsapp-jaison', version: '1.0.0' },
    { instructions: instrucoes() }
  );

  s.registerTool('status_whatsapp', {
    title: 'Status do WhatsApp',
    description: 'Mostra se o WhatsApp do robô está conectado, o número em uso, quantos envios foram feitos hoje e qual é a caixa de saída de arquivos.',
    inputSchema: {},
    annotations: { readOnlyHint: true }
  }, async () => texto({ status: estado.status, desde: estado.desde, conta: estado.conta, enviosHoje: estado.enviosHoje, limiteDia: config.limiteDia, filaPendente: estado.filaPendente, painel: config.linkPainel, caixaDeSaida: caixa(), tokenGithub: !!config.githubToken }));

  s.registerTool('listar_conversas', {
    title: 'Listar conversas',
    description: 'Lista as conversas e grupos que o WhatsApp do robô conhece, das mais recentes para as mais antigas, com nome, número ou id e data da última conversa.',
    inputSchema: {
      tipo: z.enum(['pessoa', 'grupo']).optional().describe('Filtrar por pessoas ou grupos'),
      limite: z.number().int().min(1).max(200).optional().describe('Quantidade, padrão 30')
    },
    annotations: { readOnlyHint: true }
  }, async ({ tipo, limite }) => texto({ total: contagemAgenda(), conversas: listarConversas({ tipo, limite: limite || 30 }) }));

  s.registerTool('buscar_contato', {
    title: 'Buscar contato ou grupo',
    description: 'Procura nas conversas por nome (tolera acentos e erros de digitação) ou por parte do número. Devolve candidatos com nota de semelhança de 0 a 1.',
    inputSchema: {
      termo: z.string().min(2).describe('Nome, apelido, nome do grupo ou parte do número'),
      tipo: z.enum(['pessoa', 'grupo']).optional()
    },
    annotations: { readOnlyHint: true }
  }, async ({ termo, tipo }) => texto(buscarContato(termo, { tipo, limite: 10 })));

  s.registerTool('conferir_destino', {
    title: 'Conferir destino',
    description: 'Mostra para quem uma mensagem iria, sem enviar: nome, número, se já existe conversa e se o destino é ambíguo. Use sempre antes de enviar.',
    inputSchema: { para: z.string().describe('Número com DDD, nome da pessoa ou do grupo, ou id') },
    annotations: { readOnlyHint: true }
  }, async ({ para }) => texto(await conferirDestino(para)));

  s.registerTool('listar_grupos', {
    title: 'Listar grupos',
    description: 'Lista os grupos de WhatsApp de que o robô participa, com id e nome. Use o filtro para buscar por parte do nome.',
    inputSchema: { filtro: z.string().optional().describe('Parte do nome do grupo') },
    annotations: { readOnlyHint: true }
  }, async ({ filtro }) => { try { return texto(await listarGrupos(filtro)); } catch (e) { return erro(e); } });

  s.registerTool('enviar_mensagem', {
    title: 'Enviar mensagem de texto',
    description: 'Envia uma mensagem de texto. "para" aceita número com DDD (ex.: 69999990000), id, ou o nome da pessoa ou do grupo. Se o nome for ambíguo ou o número estiver incompleto, nada é enviado e voltam os candidatos. Chame conferir_destino antes.',
    inputSchema: {
      para: z.string().describe('Número com DDD, nome ou id'),
      texto: z.string().min(1).describe('Texto da mensagem. Aceita *negrito* e _itálico_ do WhatsApp.')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
  }, async ({ para, texto: t }) => { try { return texto({ enviado: true, ...(await enviar({ para, texto: t })) }); } catch (e) { return erro(e); } });

  s.registerTool('enviar_arquivo', {
    title: 'Enviar arquivo',
    description: 'Envia um arquivo pequeno (até uns 30 KB) em base64. Para arquivos maiores, use enviar_arquivo_url. Imagens vão como foto; os demais como documento.',
    inputSchema: {
      para: z.string().describe('Número com DDD, nome ou id'),
      arquivo_base64: z.string().min(8).describe('Conteúdo do arquivo em base64 (aceita prefixo data:...;base64,)'),
      nome_arquivo: z.string().describe('Nome com extensão, ex.: relatorio-diario.pdf'),
      legenda: z.string().optional().describe('Texto que acompanha o arquivo'),
      mimetype: z.string().optional().describe('Tipo MIME; se omitido, é deduzido pela extensão')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
  }, async ({ para, arquivo_base64, nome_arquivo, legenda, mimetype }) => {
    try { return texto({ enviado: true, ...(await enviar({ para, arquivoBase64: arquivo_base64, nomeArquivo: nome_arquivo, legenda, mimetype })) }); }
    catch (e) { return erro(e); }
  });
  s.registerTool('enviar_arquivo_url', {
    title: 'Enviar arquivo por link',
    description: 'Envia um arquivo que está num link: o celular do robô baixa e envia (limite padrão de 64 MB). Use para arquivos grandes, em vez de enviar_arquivo. ' + (caixa() ? `Caixa de saída: suba o arquivo no repositório privado ${caixa().repo}, pasta ${caixa().pasta || 'raiz'}, branch main, e passe o link no formato ${caixa().exemplo}.` : 'Aceita links de arquivo do GitHub e dos sites em HOSTS_ARQUIVOS.'),
    inputSchema: {
      para: z.string().describe('Número com DDD, nome ou id'),
      url: z.string().url().describe('Link https do arquivo'),
      nome_arquivo: z.string().optional().describe('Nome com extensão que o destinatário verá; se omitido, usa o do link'),
      legenda: z.string().optional().describe('Texto que acompanha o arquivo'),
      mimetype: z.string().optional().describe('Tipo MIME; se omitido, é deduzido pela extensão')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
  }, async ({ para, url, nome_arquivo, legenda, mimetype }) => {
    try { return texto({ enviado: true, ...(await enviar({ para, arquivoUrl: url, nomeArquivo: nome_arquivo, legenda, mimetype })) }); }
    catch (e) { return erro(e); }
  });
  return s;
}

/** Handler Express para POST /mcp/:segredo (modo sem sessão: um servidor por requisição). */
export async function tratarMcp(req, res) {
  const servidor = criarServidor();
  const transporte = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transporte.close(); servidor.close(); });
  try {
    await servidor.connect(transporte);
    await transporte.handleRequest(req, res, req.body);
  } catch (e) {
    console.error('[mcp]', e);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Erro interno' }, id: null });
  }
}
