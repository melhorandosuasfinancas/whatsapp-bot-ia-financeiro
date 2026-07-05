const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LEADS_FILE = path.join(__dirname, 'dados-clientes.json');

const KEYWORDS_EMAGRECA = [
  'emagrec', 'perder peso', 'perder barriga', 'dieta', 'treino', 'academia',
  'barriga', 'gordo', 'gorda', 'fitness', 'caloria', 'projeto 21', 'emagreça',
  '21 dias', 'sedentari', 'peso', 'balança', 'exercício', 'exercicio',
  'musculação', 'musculacao', 'correr', 'caminhada', 'emagrecimento'
];

const KEYWORDS_FINANCEIRO = [
  'dívida', 'divida', 'dinheiro', 'renda', 'salário', 'salario', 'financeiro',
  'crédito', 'credito', 'pagar', 'endividado', 'endividada', 'gasto', 'conta',
  'empréstimo', 'emprestimo', 'economia', 'orçamento', 'orcamento', 'ia financeiro',
  'dívidas', 'dividas', 'juros', 'cobrança', 'cobranca', 'negativado', 'negativa',
  'spc', 'serasa', 'investimento', 'poupança', 'poupanca', 'renda extra', 'ganhar dinheiro',
  'trabalhar online', 'freelance', 'aposentadoria', 'patrimônio', 'patrimonio'
];

function lerLeads() {
  try {
    if (!fs.existsSync(LEADS_FILE)) return [];
    return JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function salvarLeads(leads) {
  fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2), 'utf8');
}

function obterLead(numero) {
  return lerLeads().find(l => l.numero === numero) || null;
}

function criarOuObterLead(numero) {
  const leads = lerLeads();
  const existente = leads.find(l => l.numero === numero);
  if (existente) return existente;

  const novo = {
    id: crypto.randomUUID(),
    numero,
    nome: null,
    problema: null,
    produto: null,
    status: 'novo',
    linkEnviado: null,
    convertido: false,
    criadoEm: new Date().toISOString(),
    atualizadoEm: new Date().toISOString()
  };
  leads.push(novo);
  salvarLeads(leads);
  return novo;
}

function atualizarLead(numero, campos) {
  const leads = lerLeads();
  const idx = leads.findIndex(l => l.numero === numero);
  if (idx === -1) return null;
  leads[idx] = { ...leads[idx], ...campos, atualizadoEm: new Date().toISOString() };
  salvarLeads(leads);
  return leads[idx];
}

function detectarProduto(texto) {
  if (!texto) return null;
  const t = texto.toLowerCase();
  const scoreEma = KEYWORDS_EMAGRECA.filter(k => t.includes(k)).length;
  const scoreIAF = KEYWORDS_FINANCEIRO.filter(k => t.includes(k)).length;
  if (scoreEma > 0 && scoreEma >= scoreIAF) return 'emagreca21dias';
  if (scoreIAF > 0) return 'ia_financeiro';
  return null;
}

function detectarLinkEnviado(textoBot) {
  if (!textoBot) return null;
  const links = [
    { regex: /pay\.finaliza\.shop\/pl\/1359bcf9ea/, produto: 'emagreca21dias', link: 'https://pay.finaliza.shop/pl/1359bcf9ea' },
    { regex: /pay\.kiwify\.com\.br\/lK6yBk6/, produto: 'emagreca21dias', link: 'https://pay.kiwify.com.br/lK6yBk6' },
    { regex: /pay\.kiwify\.com\.br\/mLXgPIv/, produto: 'emagreca21dias', link: 'https://pay.kiwify.com.br/mLXgPIv' },
    { regex: /pay\.kiwify\.com\.br\/oUsY51z/, produto: 'ia_financeiro', link: 'https://pay.kiwify.com.br/oUsY51z' },
    { regex: /pay\.kiwify\.com\.br\/V5nVOCd/, produto: 'ia_financeiro', link: 'https://pay.kiwify.com.br/V5nVOCd' },
    { regex: /pay\.kiwify\.com\.br\/RUOaYx7/, produto: 'ia_financeiro', link: 'https://pay.kiwify.com.br/RUOaYx7' },
    { regex: /pay\.kiwify\.com\.br\/Cf1Aupl/, produto: 'ia_financeiro', link: 'https://pay.kiwify.com.br/Cf1Aupl' },
  ];
  for (const { regex, produto, link } of links) {
    if (regex.test(textoBot)) return { produto, link };
  }
  return null;
}

module.exports = {
  lerLeads,
  obterLead,
  criarOuObterLead,
  atualizarLead,
  detectarProduto,
  detectarLinkEnviado
};
