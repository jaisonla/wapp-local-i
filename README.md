# WhatsApp do robô — web.jaison.eng.br

Aplicação Node que mantém um número de WhatsApp conectado (Baileys) no seu computador, publicada em
`https://web.jaison.eng.br` pelo Cloudflare Tunnel e mantida no ar pelo PM2.

| Endereço | Para quê | Proteção |
|---|---|---|
| `/conectar` | Painel: status, QR, código de pareamento, nova sessão | Usuário e senha + Cloudflare Access |
| `/mcp/<MCP_SEGREDO>` | Conector para o Claude enviar mensagens | Segredo na URL |
| `/api/status`, `/api/grupos`, `/api/enviar` | API para outros sistemas | `Authorization: Bearer <API_TOKEN>` |

> Use um **número dedicado**, nunca o pessoal ou o principal da empresa. O Baileys não é oficial e o
> WhatsApp pode bloquear números que enviam em excesso. A aplicação já espaça os envios (2,5 a 6 s) e
> limita a 200 por dia.

---

## 1. Instalar e configurar (uma vez)

Pré-requisitos: **Node.js 22 LTS** ou mais novo (nodejs.org) e **Git**. Confira no PowerShell com `node -v` e `git --version`.

```powershell
# baixe o código (precisa do Git: winget install --id Git.Git)
git clone https://github.com/jaisonla/wapp-local-i C:\wapp-local
cd C:\wapp-local
npm install
npm run configurar
```

O `configurar` cria o arquivo `.env` com senhas aleatórias e mostra:
usuário e senha do painel, URL do conector MCP e token da API. **Guarde esses dados.**

Abra o `.env` no Bloco de Notas e preencha `NUMERO_ROBO` (DDI + DDD + número, só dígitos, ex.: `5569999990000`).

## 2. Testar e conectar o número

```powershell
npm start
```

Abra `http://localhost:3000/conectar`, entre com usuário e senha e conecte:

- **QR:** no celular do robô, *Aparelhos conectados → Conectar aparelho* e leia o código.
- **Código de pareamento:** clique em *Gerar código* e, no celular, *Conectar com número de telefone*.

Quando aparecer **Conectado**, feche com `Ctrl+C`. A sessão fica salva na pasta `sessao`.

## 3. Deixar sempre no ar com PM2

O PM2 encontra a aplicação pelo arquivo `ecosystem.config.cjs`, que está na pasta do projeto. Ele diz
o nome (`whatsapp`), o arquivo a rodar (`src/index.js`) e a pasta de trabalho (a do projeto, onde está o `.env`).
Por isso os comandos precisam ser rodados **de dentro da pasta**.

```powershell
# 1. Se o PowerShell bloquear comandos instalados pelo npm ("execução de scripts foi desabilitada"):
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned

# 2. Instalar o PM2 (uma vez)
npm install -g pm2 pm2-windows-startup

# 3. Registrar e iniciar a aplicação
cd C:\wapp-local
pm2 start ecosystem.config.cjs

# 4. Conferir: deve aparecer "whatsapp" com status "online"
pm2 status

# 5. Salvar a lista de aplicações e iniciar junto com o Windows
pm2 save
pm2-startup install
```

O `pm2 save` grava quais aplicações estão rodando. Ao ligar o Windows, o `pm2-startup` abre o PM2,
que restaura essa lista e sobe o `whatsapp` de novo. Se mudar algo depois (por exemplo, adicionar outra
aplicação), rode `pm2 save` outra vez.

Se o `pm2-startup` não funcionar no seu Windows, use o Agendador de Tarefas: crie uma tarefa
**Ao fazer logon** que execute `pm2 resurrect`.

Comandos do dia a dia:

```powershell
pm2 status            # está rodando?
pm2 logs whatsapp     # ver o que está acontecendo (Ctrl+C para sair)
pm2 restart whatsapp  # depois de editar o .env
```

## 4. Publicar em web.jaison.eng.br (Cloudflare Tunnel)

1. Instale o cloudflared (PowerShell **como administrador**):
   `winget install --id Cloudflare.cloudflared`
2. No painel principal da Cloudflare: **Networking → Tunnels → Create Tunnel**.
   (É o mesmo produto que aparece em *Zero Trust → Networks*; pelo painel principal não é preciso
   ativar o Zero Trust. O túnel é gratuito: a conta inclui 1.000.)
3. Nome do túnel: `pc-escritorio`. Escolha **Windows**, copie o comando
   `cloudflared.exe service install <token>` e rode no PowerShell como administrador.
   Isso instala o túnel como serviço do Windows, que sobe sozinho com o computador.
4. Em **Public Hostname**: Subdomain `web`, Domain `jaison.eng.br`,
   Service **HTTP** `localhost:3000`. Salve.

Teste: `https://web.jaison.eng.br` deve responder `ok`.

## 5. Proteger o painel com Cloudflare Access

**Zero Trust → Access → Applications → Add an application → Self-hosted**

(O Access fica no Zero Trust. O plano gratuito cobre até 50 usuários e pode pedir um cartão no cadastro, sem cobrar.)

- Domínio `web.jaison.eng.br`, caminhos `conectar` e `conectar/*`
- Política: **Allow** · *Emails* · o seu e-mail

Não proteja `/mcp` nem `/api`: eles já exigem segredo, e o Claude não passaria pela tela de login.

## 6. Ligar ao Claude

Em claude.ai: **Configurações → Conectores → Adicionar conector personalizado**

- Nome: `WhatsApp Jaison`
- URL: `https://web.jaison.eng.br/mcp/<MCP_SEGREDO>` (a URL mostrada no passo 1)

Ferramentas disponíveis:

| Ferramenta | O que faz |
|---|---|
| `status_whatsapp` | Conectado ou não, número em uso, envios do dia |
| `listar_conversas` | Conversas e grupos mais recentes, com nome e número |
| `buscar_contato` | Procura por nome (tolera acentos e erros) ou parte do número |
| `conferir_destino` | Mostra para quem a mensagem iria, sem enviar |
| `listar_grupos` | Grupos de que o robô participa |
| `enviar_mensagem` | Envia texto |
| `enviar_arquivo` | Envia arquivo pequeno (até ~30 KB) em base64 |
| `enviar_arquivo_url` | Envia arquivo grande a partir de um link (GitHub), até 64 MB |

O Claude é instruído a chamar `conferir_destino` antes de cada envio e a mostrar nome e número para você confirmar.

**A URL do conector funciona como senha:** quem tiver ela envia mensagens pelo robô.
Para trocar: gere um novo valor para `MCP_SEGREDO` no `.env`, rode `pm2 restart whatsapp` e atualize o conector.

## 7. Conversas, contatos e conferência do destino

A aplicação mantém uma lista das conversas e grupos do número do robô em `dados/conversas.json`:

- **Na primeira conexão** (QR ou código), o WhatsApp envia a lista de conversas recentes e os nomes salvos.
- **Depois**, cada conversa nova, grupo e nome de quem manda mensagem entra na lista automaticamente.
- Se o número já estava conectado antes desta versão, use **Nova sessão** no painel uma vez para receber a lista completa.

Para nomes que o WhatsApp não informa, crie `dados/contatos.csv` (pode editar no Excel e salvar como CSV):

```
nome;numero
João Ferreira (encarregado);69 99111-2222
Compras Cargill;69 3333-4444
```

A lista é relida sozinha quando o arquivo muda.

**Como o destino é conferido antes de enviar:**

| Você informa | O que acontece |
|---|---|
| Número com DDD (10 ou 11 dígitos) | Confere se tem WhatsApp e mostra o nome, se ele estiver nas conversas. Se não estiver, avisa "fora das conversas". |
| Número incompleto | Não envia. Explica quantos dígitos faltam e sugere conversas com aqueles dígitos. |
| Nome exato ou palavra que identifica uma só conversa | Envia para ela (ex.: "maria" quando só existe uma Maria). |
| Nome ambíguo ou com erro de digitação | Não envia. Devolve os candidatos para escolher (ex.: "obra pier" → *Obra PIER – Cargill* ou *Obra PIER – Compras*). |
| Nome que não existe | Não envia. Pede o número. |

Para só permitir envios a quem já está nas conversas, use `EXIGIR_CONVERSA_EXISTENTE=sim` no `.env`.

## 8. Enviar arquivos grandes (PDF, planilhas, fotos)

Pelo conector, o Claude só consegue mandar arquivos pequenos (até uns 30 KB) dentro do pedido.
Para arquivos maiores, ele sobe o arquivo para uma **caixa de saída no GitHub** e manda só o link;
o celular baixa e envia pelo WhatsApp (até 64 MB).

**Configurar uma vez:**

1. No GitHub, crie um repositório **privado** vazio, por exemplo `wapp-arquivos`.
2. Crie um token só de leitura: **GitHub → Settings → Developer settings → Personal access tokens →
   Fine-grained tokens → Generate new token**
   - *Repository access:* **Only select repositories** → `wapp-arquivos`
   - *Permissions → Repository permissions → Contents:* **Read-only**
   - Escolha uma validade (ex.: 1 ano) e copie o token (`github_pat_...`).
3. No `.env` do celular, preencha e rode `pm2 restart whatsapp`:
   ```
   CAIXA_SAIDA=seu-usuario/wapp-arquivos
   GITHUB_TOKEN=github_pat_...
   ```
   Com `CAIXA_SAIDA` preenchido, o conector informa ao Claude, em toda conversa, onde subir os arquivos.

**No dia a dia:** peça ao Claude para enviar o arquivo. Ele coloca o arquivo em `wapp-arquivos`
e chama a ferramenta `enviar_arquivo_url` com o link. Na primeira vez, o Claude pede para você liberar
o acesso dele ao repositório `wapp-arquivos`.

Também funciona com outros sites, se você liberar em `HOSTS_ARQUIVOS` (separados por vírgula).

## 9. API (opcional)

```powershell
$h = @{ Authorization = "Bearer SEU_API_TOKEN" }
Invoke-RestMethod https://web.jaison.eng.br/api/status -Headers $h
Invoke-RestMethod https://web.jaison.eng.br/api/enviar -Method Post -Headers $h `
  -ContentType "application/json" -Body '{"para":"69999990000","texto":"Teste do robô"}'
```

Campos de `/api/enviar`: `para`, `texto`, e para arquivo `arquivo_base64` **ou** `arquivo_url`, `nome_arquivo`, `legenda`, `mimetype`.

Outras rotas: `GET /api/conversas?tipo=grupo&limite=50`, `GET /api/buscar?q=maria`, `GET /api/conferir?para=obra pier`.

## Ajustes no `.env`

| Variável | Padrão | O que faz |
|---|---|---|
| `INTERVALO_MIN_MS` / `INTERVALO_MAX_MS` | 2500 / 6000 | Espera aleatória entre envios |
| `LIMITE_DIA` | 200 | Máximo de envios por dia |
| `DESTINOS_PERMITIDOS` | vazio (todos) | Restringe a números, ids ou nomes de grupo, separados por vírgula |
| `CAIXA_SAIDA` | vazio | Repositório (dono/nome) onde o Claude coloca os arquivos |
| `CAIXA_PASTA` | saida | Pasta dentro desse repositório |
| `GITHUB_TOKEN` | vazio | Token só de leitura da caixa de saída de arquivos |
| `HOSTS_ARQUIVOS` | vazio | Outros sites de onde o robô pode baixar arquivos |
| `LIMITE_ARQUIVO_MB` | 64 | Tamanho máximo de arquivo |
| `EXIGIR_CONVERSA_EXISTENTE` | nao | Se `sim`, só envia para quem já está nas conversas ou no `contatos.csv` |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | vazio | Aviso no Telegram quando o WhatsApp cair |

Depois de editar: `pm2 restart whatsapp`.

## Instalar num celular Android (Termux)

Instale o **Termux** e o **Termux:Boot** pelo F-Droid (a versão da Play Store não funciona). No Termux:

```bash
pkg update -y && pkg upgrade -y
pkg install -y nodejs-lts git cloudflared nano
git clone https://github.com/jaisonla/wapp-local-i ~/wapp-local
cd ~/wapp-local
npm install
npm run configurar
nano .env                      # preencha NUMERO_ROBO; salve com CTRL+O, Enter, CTRL+X
npm start                      # conecte em http://localhost:3000/conectar e pare com CTRL+C
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 start cloudflared --name tunel -- tunnel run --token SEU_TOKEN_DO_TUNEL
pm2 save
mkdir -p ~/.termux/boot
printf '#!/data/data/com.termux/files/usr/bin/sh\ntermux-wake-lock\npm2 resurrect\n' > ~/.termux/boot/iniciar.sh
chmod +x ~/.termux/boot/iniciar.sh
termux-wake-lock
```

Nas configurações do Android, deixe o Termux e o Termux:Boot **sem restrição de bateria**.
No túnel da Cloudflare, escolha *Debian* e copie só o token da caixa *Or, run tunnel (manual)*.

## Atualizar

```powershell
cd C:\wapp-local      # no Termux: cd ~/wapp-local
git pull
npm install
pm2 restart whatsapp
```

O `.env`, a sessão e a lista de conversas ficam fora do Git e não são afetados.

## Quando algo der errado

- **Painel mostra "Desconectado":** a sessão foi encerrada no celular. Abra `/conectar` e conecte de novo.
- **"Reconectando" por muito tempo:** veja `pm2 logs whatsapp`. Sem internet ou WhatsApp atualizado
  (nesse caso atualize o Baileys com `npm install baileys@latest` e `pm2 restart whatsapp`).
- **`web.jaison.eng.br` não abre:** o computador está desligado, suspenso ou o serviço do túnel parou.
  Em *Opções de energia*, deixe **Suspender: Nunca**.
- **Envios de cada mensagem ficam em `logs/envios.jsonl`.**

Este repositório é público: nunca faça commit do `.env`, da pasta `sessao` nem da pasta `dados` (o `.gitignore` já os exclui).

Arquivos que nunca devem ser compartilhados: `.env`, a pasta `sessao` (é o login do WhatsApp) e a pasta `dados` (nomes e números das conversas).

---

## Controle de gastos (grupo + áudio)

Com `GRUPO_GASTOS` preenchido no `.env`, o robô:

- guarda cada mensagem do grupo (texto, áudio, foto com legenda, edição, apagada) em `dados/gastos-mensagens.jsonl`;
- transcreve os áudios pela Groq (`GROQ_API_KEY`), um por vez, sem processar áudio no aparelho, e responde no grupo citando o áudio;
- ignora só as mensagens que o próprio script enviou (ids em `dados/enviadas.json`), então o que você digita ou grava à mão no número do robô também conta;
- oferece ao Claude as ferramentas `ler_mensagens_gastos` e `confirmar_leitura_gastos`.

Instalar e voltar atrás (no Termux):

```bash
cd ~/wapp-local && git fetch && git checkout gastos-audio && npm install && pm2 restart whatsapp --update-env
# desfazer
cd ~/wapp-local && git checkout main && pm2 restart whatsapp --update-env
```

Acompanhar: `pm2 logs whatsapp --lines 50` (linhas `[gastos]`).
