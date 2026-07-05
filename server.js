require("dotenv").config();
const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const axios = require("axios");
const { gerarSystemPrompt, getNomeAleatorio } = require("./systemPrompt");
const { criarOuObterLead, atualizarLead, detectarProduto, detectarLinkEnviado, lerLeads } = require("./leads");

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

let botAtivo = process.env.BOT_ENABLED !== "false";

app.get("/bot/status", (req, res) => {
  res.json({ ativo: botAtivo, mensagem: botAtivo ? "Bot LIGADO — respondendo automaticamente" : "Bot DESLIGADO — atendimento manual" });
});

app.post("/bot/on", (req, res) => {
  botAtivo = true;
  console.log("[BOT] Ativado manualmente");
  res.json({ ativo: true, mensagem: "Bot LIGADO ✅" });
});

app.post("/bot/off", (req, res) => {
  botAtivo = false;
  console.log("[BOT] Desativado manualmente");
  res.json({ ativo: false, mensagem: "Bot DESLIGADO ⏸️ — você assumiu o atendimento" });
});

// Mapa: numero -> { historico, nome, produto }
const conversas = new Map();
const MAX_HISTORICO = 20;

async function enviarMensagem(numero, texto) {
  const url = `${process.env.EVOLUTION_API_URL}/message/sendText/${process.env.EVOLUTION_INSTANCE}`;
  await axios.post(
    url,
    { number: numero, text: texto },
    { headers: { apikey: process.env.EVOLUTION_API_KEY } }
  );
}

async function chamarIA(numero, mensagemUsuario) {
  // Inicializa ou recupera conversa
  if (!conversas.has(numero)) {
    const nome = getNomeAleatorio();
    conversas.set(numero, { historico: [], nome, produto: null });
    console.log(`Novo contato ${numero} — atendente: ${nome}`);
  }

  const conversa = conversas.get(numero);
  const { historico, nome } = conversa;

  // Detecta produto se ainda não detectado
  if (!conversa.produto) {
    const produtoDetectado = detectarProduto(mensagemUsuario);
    if (produtoDetectado) {
      conversa.produto = produtoDetectado;
      atualizarLead(numero, { produto: produtoDetectado, status: 'conversando' });
      console.log(`[LEAD] ${numero} — produto detectado: ${produtoDetectado}`);
    }
  }

  historico.push({ role: "user", content: mensagemUsuario });

  const historicoRecente = historico.slice(-MAX_HISTORICO);

  const response = await anthropic.messages.create({
    model: process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001",
    max_tokens: 600,
    system: gerarSystemPrompt(nome, conversa.produto),
    messages: historicoRecente,
  });

  const textoResposta = response.content[0].text;
  historico.push({ role: "assistant", content: textoResposta });

  if (historico.length > MAX_HISTORICO * 2)
    conversa.historico.splice(0, MAX_HISTORICO);

  // Detecta se link foi enviado e atualiza lead
  const linkInfo = detectarLinkEnviado(textoResposta);
  if (linkInfo) {
    const updateData = { status: 'link_enviado', linkEnviado: linkInfo.link };
    if (!conversa.produto) {
      conversa.produto = linkInfo.produto;
      updateData.produto = linkInfo.produto;
    }
    atualizarLead(numero, updateData);
    console.log(`[LEAD] ${numero} — link enviado: ${linkInfo.link}`);
  }

  return textoResposta;
}

function normalizarNumero(raw) {
  if (!raw) return null;
  let n = String(raw).replace(/\D/g, "");
  if (n.startsWith("0")) n = n.slice(1);
  if (!n.startsWith("55")) n = "55" + n;
  return n.length >= 12 ? n : null;
}

async function gerarMensagemCarrinhoAbandonado(nome, nomeCliente, nomeProduto, checkoutLink) {
  const response = await anthropic.messages.create({
    model: process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001",
    max_tokens: 200,
    messages: [{
      role: "user",
      content: `Você é ${nome}, atendente humano.
Um cliente chamado ${nomeCliente || "cliente"} estava interessado em "${nomeProduto || "nosso material"}" mas não finalizou a compra.
Escreva UMA mensagem de recuperação de carrinho para WhatsApp. Regras:
- Curta (máximo 4 linhas)
- Use o nome "${nomeCliente || "olá"}" de forma natural
- Mencione o produto de forma leve, sem pressão
- Crie senso de oportunidade
- Ofereça ajuda caso tenha alguma dúvida
- ${checkoutLink ? `Inclua o link no final: ${checkoutLink}` : "NÃO inclua link ainda"}
- Tom humano, caloroso — NUNCA robótico
Responda APENAS com o texto da mensagem, sem aspas, sem explicação.`
    }],
  });
  return response.content[0].text.trim();
}

async function gerarMensagemRemarketing(nome) {
  const response = await anthropic.messages.create({
    model: process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001",
    max_tokens: 150,
    messages: [{
      role: "user",
      content: `Você é ${nome}, atendente humano.
Envie UMA mensagem de remarketing para alguém que entrou em contato mas não comprou nada.
Regras:
- Curta (máximo 3 linhas)
- Pessoal e calorosa, como se lembrasse da pessoa
- NÃO citar produto nem preço ainda — objetivo é reativar a conversa
- Terminar com uma pergunta aberta sobre situação financeira OU saúde/disposição (escolha um)
Gere UMA mensagem diferente e natural. Responda APENAS com o texto, sem aspas, sem explicação.`
    }],
  });
  return response.content[0].text.trim();
}

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  if (!botAtivo) return;
  try {
    const body = req.body;
    if (
      body.event !== "messages.upsert" ||
      body.data?.key?.fromMe === true ||
      !body.data?.message?.conversation
    ) return;

    const numero = body.data.key.remoteJid;
    const texto = body.data.message.conversation?.trim();
    if (!texto || numero.includes("@g.us")) return;

    // Cria ou obtém lead
    const lead = criarOuObterLead(numero);
    if (lead.status === 'novo') {
      atualizarLead(numero, { status: 'conversando' });
    }

    // Tenta extrair nome da primeira mensagem (heurística simples)
    if (!lead.nome && texto.length < 30 && /^[A-Za-zÀ-ÿ\s]+$/.test(texto.trim())) {
      atualizarLead(numero, { nome: texto.trim() });
    }

    console.log(`[${numero}]: ${texto}`);
    const resposta = await chamarIA(numero, texto);

    const delay = Math.min(1500 + resposta.length * 15, 5000);
    await new Promise((r) => setTimeout(r, delay));
    await enviarMensagem(numero, resposta);
  } catch (err) {
    console.error("Erro webhook:", err.message);
  }
});

// Dispara remarketing para lista de números
app.post("/remarketing", async (req, res) => {
  const { numeros } = req.body;
  if (!Array.isArray(numeros) || numeros.length === 0)
    return res.status(400).json({ erro: "Informe um array 'numeros'" });

  res.json({ ok: true, total: numeros.length, status: "disparando em background" });

  for (const numero of numeros) {
    try {
      const nome = getNomeAleatorio();
      if (!conversas.has(numero)) {
        conversas.set(numero, { historico: [], nome, produto: null });
      }
      const mensagem = await gerarMensagemRemarketing(nome);
      console.log(`[REMARKETING] ${numero}: ${mensagem}`);
      await enviarMensagem(numero, mensagem);
      conversas.get(numero).historico.push({ role: "assistant", content: mensagem });
      await new Promise((r) => setTimeout(r, 8000 + Math.random() * 4000));
    } catch (err) {
      console.error(`[REMARKETING] Erro em ${numero}:`, err.message);
    }
  }
  console.log(`[REMARKETING] Concluído — ${numeros.length} contatos abordados`);
});

// Webhook carrinho abandonado Kiwify
const DELAY_CARRINHO_MS = parseInt(process.env.DELAY_CARRINHO_MIN || "60") * 60 * 1000;

app.post("/webhook-kiwify", async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    console.log("[KIWIFY] payload:", JSON.stringify(body).slice(0, 500));

    const customer = body.Customer || body.customer || body.data?.Customer || body.data?.customer || {};
    const product  = body.Product  || body.product  || body.data?.Product  || body.data?.product  || {};

    const nomeCliente  = customer.full_name || customer.name || customer.nome || "";
    const telefoneRaw  = customer.mobile || customer.phone || customer.telefone || customer.celular || "";
    const nomeProduto  = product.name || product.nome || body.product_name || body.offer_name || body.data?.product_name || "";
    const checkoutLink = body.checkout_link || body.checkout_url || body.data?.checkout_link || "";

    const numero = normalizarNumero(telefoneRaw);
    if (!numero) {
      console.log("[KIWIFY] Telefone não encontrado — raw:", telefoneRaw);
      return;
    }

    const delayMin = Math.round(DELAY_CARRINHO_MS / 60000);
    console.log(`[KIWIFY] Carrinho abandonado — ${nomeCliente} (${numero}) — "${nomeProduto}" — disparo em ${delayMin}min`);

    setTimeout(async () => {
      try {
        const nome = getNomeAleatorio();
        const mensagem = await gerarMensagemCarrinhoAbandonado(nome, nomeCliente, nomeProduto, checkoutLink);
        if (!conversas.has(numero)) conversas.set(numero, { historico: [], nome, produto: null });
        conversas.get(numero).historico.push({ role: "assistant", content: mensagem });
        await enviarMensagem(numero, mensagem);
        console.log(`[KIWIFY] Mensagem enviada para ${numero}: ${mensagem.slice(0, 80)}...`);
      } catch (err) {
        console.error(`[KIWIFY] Erro ao enviar para ${numero}:`, err.message);
      }
    }, DELAY_CARRINHO_MS);

  } catch (err) {
    console.error("[KIWIFY] Erro geral:", err.message);
  }
});

// ────────────────────────────────────────────────
// LEADS API
// ────────────────────────────────────────────────

app.get("/api/leads", (req, res) => {
  const leads = lerLeads();
  const { produto, status } = req.query;
  let filtrados = leads;
  if (produto) filtrados = filtrados.filter(l => l.produto === produto);
  if (status) filtrados = filtrados.filter(l => l.status === status);
  filtrados.sort((a, b) => new Date(b.criadoEm) - new Date(a.criadoEm));
  res.json(filtrados);
});

app.post("/api/leads/:numero/convertido", (req, res) => {
  const numero = decodeURIComponent(req.params.numero);
  const lead = atualizarLead(numero, { convertido: true, status: 'convertido' });
  if (!lead) return res.status(404).json({ erro: "Lead não encontrado" });
  res.json({ ok: true, lead });
});

app.patch("/api/leads/:numero", (req, res) => {
  const numero = decodeURIComponent(req.params.numero);
  const campos = req.body;
  const lead = atualizarLead(numero, campos);
  if (!lead) return res.status(404).json({ erro: "Lead não encontrado" });
  res.json({ ok: true, lead });
});

// ────────────────────────────────────────────────
// DASHBOARD
// ────────────────────────────────────────────────

app.get("/dashboard", (req, res) => {
  res.send(DASHBOARD_HTML);
});

// ────────────────────────────────────────────────
// ROTAS AUXILIARES
// ────────────────────────────────────────────────

app.get("/", (req, res) =>
  res.json({ status: "online", bot: "IA Financeiro + Projeto 21 Dias — Atendimento" })
);

app.get("/atendentes", (req, res) => {
  const lista = {};
  conversas.forEach((v, k) => { lista[k] = v.nome; });
  res.json(lista);
});

app.delete("/conversa/:numero", (req, res) => {
  conversas.delete(req.params.numero + "@s.whatsapp.net");
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot rodando na porta ${PORT}`));

// ────────────────────────────────────────────────
// DASHBOARD HTML (inline)
// ────────────────────────────────────────────────

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Dashboard — Bot WhatsApp</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; }
  .header { background: #1e293b; padding: 20px 32px; border-bottom: 1px solid #334155; display: flex; align-items: center; gap: 12px; }
  .header h1 { font-size: 1.25rem; font-weight: 600; }
  .header .badge { background: #22c55e; color: #fff; font-size: 0.7rem; padding: 2px 8px; border-radius: 99px; font-weight: 600; }
  .main { padding: 32px; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 16px; margin-bottom: 32px; }
  .stat { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 20px; }
  .stat .label { font-size: 0.75rem; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; }
  .stat .value { font-size: 2rem; font-weight: 700; }
  .stat.green .value { color: #22c55e; }
  .stat.blue .value { color: #3b82f6; }
  .stat.purple .value { color: #a855f7; }
  .stat.orange .value { color: #f97316; }
  .stat.red .value { color: #ef4444; }
  .filters { display: flex; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; align-items: center; }
  .filter-btn { background: #1e293b; border: 1px solid #334155; color: #e2e8f0; padding: 8px 16px; border-radius: 8px; cursor: pointer; font-size: 0.875rem; transition: all 0.15s; }
  .filter-btn:hover, .filter-btn.active { background: #3b82f6; border-color: #3b82f6; }
  .search { background: #1e293b; border: 1px solid #334155; color: #e2e8f0; padding: 8px 14px; border-radius: 8px; font-size: 0.875rem; width: 220px; outline: none; }
  .search:focus { border-color: #3b82f6; }
  table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 12px; overflow: hidden; }
  th { background: #0f172a; color: #94a3b8; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; padding: 12px 16px; text-align: left; }
  td { padding: 12px 16px; border-top: 1px solid #1e293b; font-size: 0.875rem; vertical-align: top; background: #1e293b; }
  tr:hover td { background: #263248; }
  .badge-produto { display: inline-block; padding: 2px 8px; border-radius: 99px; font-size: 0.7rem; font-weight: 600; }
  .badge-emagreca21dias { background: #166534; color: #86efac; }
  .badge-ia_financeiro { background: #1e3a5f; color: #93c5fd; }
  .badge-null { background: #292524; color: #a8a29e; }
  .badge-status { display: inline-block; padding: 2px 8px; border-radius: 99px; font-size: 0.7rem; font-weight: 600; }
  .badge-novo { background: #292524; color: #a8a29e; }
  .badge-conversando { background: #1e3a5f; color: #93c5fd; }
  .badge-interessado { background: #3f2d00; color: #fcd34d; }
  .badge-link_enviado { background: #2d1b4e; color: #c4b5fd; }
  .badge-convertido { background: #166534; color: #86efac; }
  .btn-conv { background: #166534; color: #86efac; border: none; padding: 4px 10px; border-radius: 6px; cursor: pointer; font-size: 0.75rem; font-weight: 600; }
  .btn-conv:hover { background: #15803d; }
  .link-short { color: #60a5fa; text-decoration: none; font-size: 0.75rem; display: block; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .empty { text-align: center; padding: 60px; color: #475569; }
  .refresh { background: #1e293b; border: 1px solid #334155; color: #94a3b8; padding: 8px 14px; border-radius: 8px; cursor: pointer; font-size: 0.875rem; margin-left: auto; }
  .refresh:hover { border-color: #64748b; color: #e2e8f0; }
</style>
</head>
<body>
<div class="header">
  <h1>🤖 Bot WhatsApp — Leads</h1>
  <span class="badge" id="botStatus">...</span>
</div>
<div class="main">
  <div class="stats" id="stats"></div>
  <div class="filters">
    <button class="filter-btn active" data-filter="todos">Todos</button>
    <button class="filter-btn" data-filter="emagreca21dias">💪 21 Dias</button>
    <button class="filter-btn" data-filter="ia_financeiro">💰 IA Financeiro</button>
    <button class="filter-btn" data-filter="link_enviado">Link Enviado</button>
    <button class="filter-btn" data-filter="convertido">Convertidos</button>
    <input class="search" type="text" id="searchInput" placeholder="Buscar número ou nome...">
    <button class="refresh" onclick="carregarLeads()">↻ Atualizar</button>
  </div>
  <div id="tableContainer"></div>
</div>

<script>
let allLeads = [];
let filtroAtual = 'todos';
let buscaAtual = '';

async function carregarStatus() {
  try {
    const r = await fetch('/bot/status');
    const d = await r.json();
    const el = document.getElementById('botStatus');
    el.textContent = d.ativo ? 'LIGADO' : 'DESLIGADO';
    el.style.background = d.ativo ? '#22c55e' : '#ef4444';
  } catch {}
}

async function carregarLeads() {
  try {
    const r = await fetch('/api/leads');
    allLeads = await r.json();
    renderStats();
    renderTabela();
  } catch (e) {
    document.getElementById('tableContainer').innerHTML = '<p class="empty">Erro ao carregar leads.</p>';
  }
}

function renderStats() {
  const total = allLeads.length;
  const ema = allLeads.filter(l => l.produto === 'emagreca21dias').length;
  const iaf = allLeads.filter(l => l.produto === 'ia_financeiro').length;
  const linkEnviado = allLeads.filter(l => l.status === 'link_enviado').length;
  const convertidos = allLeads.filter(l => l.convertido).length;
  const taxaConv = total > 0 ? ((convertidos / total) * 100).toFixed(1) : '0';

  document.getElementById('stats').innerHTML = \`
    <div class="stat blue"><div class="label">Total de Leads</div><div class="value">\${total}</div></div>
    <div class="stat green"><div class="label">💪 21 Dias</div><div class="value">\${ema}</div></div>
    <div class="stat purple"><div class="label">💰 IA Financeiro</div><div class="value">\${iaf}</div></div>
    <div class="stat orange"><div class="label">Link Enviado</div><div class="value">\${linkEnviado}</div></div>
    <div class="stat green"><div class="label">Convertidos</div><div class="value">\${convertidos}</div></div>
    <div class="stat blue"><div class="label">Taxa Conv.</div><div class="value">\${taxaConv}%</div></div>
  \`;
}

function renderTabela() {
  let leads = allLeads;

  if (filtroAtual === 'emagreca21dias') leads = leads.filter(l => l.produto === 'emagreca21dias');
  else if (filtroAtual === 'ia_financeiro') leads = leads.filter(l => l.produto === 'ia_financeiro');
  else if (filtroAtual === 'link_enviado') leads = leads.filter(l => l.status === 'link_enviado');
  else if (filtroAtual === 'convertido') leads = leads.filter(l => l.convertido);

  if (buscaAtual) {
    const q = buscaAtual.toLowerCase();
    leads = leads.filter(l => (l.numero || '').includes(q) || (l.nome || '').toLowerCase().includes(q));
  }

  if (leads.length === 0) {
    document.getElementById('tableContainer').innerHTML = '<p class="empty">Nenhum lead encontrado.</p>';
    return;
  }

  const rows = leads.map(l => {
    const produtoBadge = l.produto
      ? \`<span class="badge-produto badge-\${l.produto}">\${l.produto === 'emagreca21dias' ? '💪 21 Dias' : '💰 IA Financeiro'}</span>\`
      : '<span class="badge-produto badge-null">?</span>';
    const statusBadge = \`<span class="badge-status badge-\${l.status}">\${l.status}</span>\`;
    const link = l.linkEnviado ? \`<a class="link-short" href="\${l.linkEnviado}" target="_blank">\${l.linkEnviado.split('/').pop()}</a>\` : '—';
    const convBtn = l.convertido ? '✅' : \`<button class="btn-conv" onclick="marcarConvertido('\${encodeURIComponent(l.numero)}')">Converteu</button>\`;
    const data = new Date(l.criadoEm).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    return \`<tr>
      <td>\${l.nome || '—'}</td>
      <td style="font-family:monospace;font-size:0.8rem">\${l.numero}</td>
      <td>\${produtoBadge}</td>
      <td>\${statusBadge}</td>
      <td style="max-width:200px;color:#94a3b8;font-size:0.8rem">\${l.problema || '—'}</td>
      <td>\${link}</td>
      <td>\${convBtn}</td>
      <td style="color:#64748b;font-size:0.75rem">\${data}</td>
    </tr>\`;
  }).join('');

  document.getElementById('tableContainer').innerHTML = \`
    <table>
      <thead><tr>
        <th>Nome</th><th>WhatsApp</th><th>Produto</th><th>Status</th>
        <th>Problema</th><th>Link Enviado</th><th>Converteu?</th><th>Data</th>
      </tr></thead>
      <tbody>\${rows}</tbody>
    </table>
  \`;
}

async function marcarConvertido(numeroEnc) {
  try {
    await fetch(\`/api/leads/\${numeroEnc}/convertido\`, { method: 'POST' });
    await carregarLeads();
  } catch (e) {
    alert('Erro ao marcar como convertido');
  }
}

document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    filtroAtual = btn.dataset.filter;
    renderTabela();
  });
});

document.getElementById('searchInput').addEventListener('input', e => {
  buscaAtual = e.target.value;
  renderTabela();
});

// Carrega ao iniciar
carregarStatus();
carregarLeads();
// Atualiza automaticamente a cada 30s
setInterval(() => { carregarStatus(); carregarLeads(); }, 30000);
</script>
</body>
</html>`;
