require("dotenv").config();
const express = require("express");
const Groq = require("groq-sdk");
const axios = require("axios");
const { gerarSystemPrompt, getNomeAleatorio } = require("./systemPrompt");

const app = express();
app.use(express.json());

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Mapa: numero -> { historico, nomeAtendente }
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
  if (!conversas.has(numero)) {
    const nome = getNomeAleatorio();
    conversas.set(numero, { historico: [], nome });
    console.log(`Novo contato ${numero} — atendente: ${nome}`);
  }

  const { historico, nome } = conversas.get(numero);
  historico.push({ role: "user", content: mensagemUsuario });

  const historicoRecente = historico.slice(-MAX_HISTORICO);

  const resposta = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    max_tokens: 600,
    temperature: 0.8,
    messages: [
      { role: "system", content: gerarSystemPrompt(nome) },
      ...historicoRecente
    ],
  });

  const textoResposta = resposta.choices[0].message.content;
  historico.push({ role: "assistant", content: textoResposta });

  if (historico.length > MAX_HISTORICO * 2)
    conversas.get(numero).historico.splice(0, MAX_HISTORICO);

  return textoResposta;
}

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
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

    console.log(`[${numero}]: ${texto}`);
    const resposta = await chamarIA(numero, texto);

    const delay = Math.min(1500 + resposta.length * 15, 5000);
    await new Promise((r) => setTimeout(r, delay));
    await enviarMensagem(numero, resposta);
  } catch (err) {
    console.error("Erro:", err.message);
  }
});

app.get("/", (req, res) =>
  res.json({ status: "online", bot: "IA Financeiro — Equipe de Atendimento" })
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
