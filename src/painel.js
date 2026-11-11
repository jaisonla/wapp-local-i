/* Página de conexão: QR, código de pareamento e nova sessão. Servida em /conectar. */
export const paginaPainel = `<!doctype html>
<html lang="pt-BR"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Conexão do WhatsApp</title>
<style>
:root{--bg:#16191C;--card:#1E2226;--line:#2A3036;--fg:#E9ECEE;--muted:#A7B0B8;--ok:#43B581;--warn:#EE7A2B;--err:#E0524D;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:720px;margin:0 auto;padding:24px 16px 48px;display:grid;gap:16px}
h1{font-size:1.4rem;margin:0}.muted{color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:18px;display:grid;gap:12px}
.st{display:flex;align-items:center;gap:10px;font-weight:600}.dot{width:12px;height:12px;border-radius:50%;background:var(--muted)}
.st.conectado .dot{background:var(--ok)}.st.aguardando_conexao .dot,.st.reconectando .dot{background:var(--warn)}.st.desconectado .dot{background:var(--err)}
#qr{background:#fff;border-radius:6px;padding:10px;width:min(320px,100%);aspect-ratio:1;display:grid;place-items:center;color:#333}
#qr img{width:100%;height:auto}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
input{font:inherit;padding:9px 11px;border-radius:4px;border:1px solid var(--line);background:var(--bg);color:var(--fg);min-width:0;flex:1}
button{font:600 15px system-ui,sans-serif;padding:9px 14px;border-radius:4px;border:1px solid var(--warn);background:var(--warn);color:#1A1206;cursor:pointer}
button.ghost{background:transparent;color:var(--fg);border-color:var(--line)}
#codigo{font:700 2rem/1 ui-monospace,Consolas,monospace;letter-spacing:.12em}
ol{margin:0;padding-left:1.2rem}.msg{min-height:1.4em;font-size:.95rem}.msg.err{color:var(--err)}
dl{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;margin:0;font-size:.95rem}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
</style></head><body><main>
<h1>Conexão do WhatsApp do robô</h1>
<section class="card">
  <div class="st" id="st"><span class="dot"></span><span id="stTxt">Carregando…</span></div>
  <dl id="info"></dl>
</section>
<section class="card" id="cardQr" hidden>
  <strong>Opção 1 · Ler o QR</strong>
  <ol class="muted"><li>No celular do número do robô, abra o WhatsApp.</li><li>Toque em <b>Aparelhos conectados → Conectar aparelho</b>.</li><li>Aponte a câmera para o código abaixo. Ele muda a cada 20 segundos.</li></ol>
  <div id="qr">Aguardando QR…</div>
</section>
<section class="card" id="cardPar" hidden>
  <strong>Opção 2 · Código de pareamento (sem câmera)</strong>
  <ol class="muted"><li>Informe o número do robô com DDI e DDD.</li><li>No celular: <b>Aparelhos conectados → Conectar aparelho → Conectar com número de telefone</b>.</li><li>Digite o código que aparecer aqui.</li></ol>
  <div class="row"><input id="num" inputmode="numeric" placeholder="5569999990000" aria-label="Número do robô"><button id="btnPar" type="button">Gerar código</button></div>
  <div id="codigo"></div><div class="msg" id="msgPar"></div>
</section>
<section class="card">
  <strong>Nova sessão</strong>
  <span class="muted">Desconecta o número atual e gera um QR novo. Use quando trocar de número ou se a conexão não voltar sozinha.</span>
  <div class="row"><button class="ghost" id="btnNova" type="button">Desconectar e gerar novo QR</button><span class="msg" id="msgNova"></span></div>
  <div class="row" id="conf" hidden><span>Confirma desconectar o número atual?</span><button id="sim" type="button">Sim, desconectar</button><button class="ghost" id="nao" type="button">Cancelar</button></div>
</section>
</main>
<script>
const $=id=>document.getElementById(id);
const NOMES={iniciando:'Iniciando',aguardando_conexao:'Aguardando conexão',conectado:'Conectado',reconectando:'Reconectando…',desconectado:'Desconectado'};
async function atualizar(){
  try{
    const r=await fetch('/conectar/estado',{cache:'no-store'}); const e=await r.json();
    $('st').className='st '+e.status; $('stTxt').textContent=NOMES[e.status]||e.status;
    const linhas=[];
    if(e.conta) linhas.push(['Número',e.conta.numero+(e.conta.nome?' · '+e.conta.nome:'')]);
    linhas.push(['Desde',new Date(e.desde).toLocaleString('pt-BR')]);
    linhas.push(['Envios hoje',e.enviosHoje+' de '+e.limiteDia]);
    if(e.agenda) linhas.push(['Conversas conhecidas',e.agenda.pessoas+' pessoas · '+e.agenda.grupos+' grupos'+(e.agenda.manuais?' · '+e.agenda.manuais+' no contatos.csv':'')]);
    if(e.ultimoErro&&e.status!=='conectado') linhas.push(['Último erro',e.ultimoErro]);
    $('info').innerHTML=linhas.map(([a,b])=>'<dt>'+a+'</dt><dd>'+String(b).replace(/</g,'&lt;')+'</dd>').join('');
    const precisa=e.status!=='conectado'; $('cardQr').hidden=!precisa; $('cardPar').hidden=!precisa;
    if(e.qrDataUrl){ if(!$('qr').querySelector('img')||$('qr').dataset.q!==e.qrDataUrl.slice(-40)){ $('qr').innerHTML='<img alt="QR para conectar o WhatsApp" src="'+e.qrDataUrl+'">'; $('qr').dataset.q=e.qrDataUrl.slice(-40);} }
    else $('qr').textContent=precisa?'Aguardando QR…':'';
    if(!$('num').value&&e.numeroRobo) $('num').value=e.numeroRobo;
  }catch(err){ $('stTxt').textContent='Sem resposta do servidor'; }
}
$('btnPar').onclick=async()=>{
  $('msgPar').className='msg'; $('msgPar').textContent='Gerando…'; $('codigo').textContent='';
  const r=await fetch('/conectar/codigo',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({numero:$('num').value})});
  const j=await r.json(); if(r.ok){ $('codigo').textContent=j.codigo; $('msgPar').textContent='Digite este código no celular em até 1 minuto.'; }
  else { $('msgPar').className='msg err'; $('msgPar').textContent=j.erro; }
};
$('btnNova').onclick=()=>{ $('conf').hidden=false; };
$('nao').onclick=()=>{ $('conf').hidden=true; };
$('sim').onclick=async()=>{ $('conf').hidden=true; $('msgNova').textContent='Desconectando…';
  const r=await fetch('/conectar/nova-sessao',{method:'POST'}); $('msgNova').textContent=r.ok?'Sessão encerrada. Aguarde o novo QR.':'Não foi possível encerrar.'; atualizar(); };
atualizar(); setInterval(atualizar,3000);
</script></body></html>`;
