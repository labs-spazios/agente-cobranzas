require("dotenv").config();
const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const axios = require("axios");

const app = express();
app.use(express.json());

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Historial por número de teléfono ─────────────────────
const sesiones = new Map();

function obtenerHistorial(telefono) {
  if (!sesiones.has(telefono)) sesiones.set(telefono, []);
  return sesiones.get(telefono);
}

function agregarMensaje(telefono, role, content) {
  const h = obtenerHistorial(telefono);
  h.push({ role, content });
  if (h.length > 20) h.splice(0, 2);
}

// ── Tool: consulta a tu API ───────────────────────────────
async function consultarCliente(dni) {
  try {
    const res = await axios.post(
      process.env.DOLIBARR_ENDPOINT,
      { dni },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.DOLIBARR_TOKEN}`,
        },
        timeout: 20000,
      }
    );
    return res.data;
  } catch (err) {
    return { found: false, error: err.message };
  }
}

// ── Definición de la tool para Claude ────────────────────
const TOOLS = [
  {
    name: "consultar_cliente",
    description: `Consulta la información de deuda de un cliente por DNI.
Usá esta tool cuando el usuario quiera saber: su deuda, próxima cuota, vencimiento, o estado de cuenta.
Requiere DNI. Si no lo tenés, pedíselo primero.`,
    input_schema: {
      type: "object",
      properties: {
        dni: {
          type: "string",
          description: "DNI del cliente, solo números, sin puntos ni espacios.",
        },
      },
      required: ["dni"],
    },
  },
];

// ── System prompt ─────────────────────────────────────────
const SYSTEM = `Sos el asistente de cobranzas de Fidinmo que atiende por WhatsApp.

REGLAS:
- Respondé siempre en español, de forma corta y amable. Máximo 3 líneas.
- Si el usuario pregunta por su deuda, cuota o cuenta: necesitás su DNI.
- Pedí el DNI UNA sola vez. Si ya lo diste antes en la conversación, no lo pidas de nuevo.
- Un DNI válido tiene 7 u 8 dígitos solo con números.
- Si el DNI no es válido, avisá una vez y pedilo de nuevo.
- Si la consulta no requiere datos personales (cómo pagar, horarios), respondé directo sin pedir DNI.
- Si no podés resolver algo, decí: "Te comunico con un asesor ahora."
- No uses markdown. No uses listas. Solo texto plano.`;

// ── Procesar mensaje con Claude ───────────────────────────
async function procesarMensaje(telefono, mensajeUsuario) {
  agregarMensaje(telefono, "user", mensajeUsuario);

  let response = await claude.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 512,
    system: SYSTEM,
    tools: TOOLS,
    messages: obtenerHistorial(telefono),
  });

  // Loop de tool use
  while (response.stop_reason === "tool_use") {
    const assistantContent = response.content;
    agregarMensaje(telefono, "assistant", assistantContent);

    const toolResults = [];
    for (const block of assistantContent) {
      if (block.type === "tool_use") {
        console.log(`[Tool] Consultando DNI: ${block.input.dni}`);
        const resultado = await consultarCliente(block.input.dni);
        console.log(`[Tool] Resultado:`, resultado);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(resultado),
        });
      }
    }

    agregarMensaje(telefono, "user", toolResults);

    response = await claude.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 512,
      system: SYSTEM,
      tools: TOOLS,
      messages: obtenerHistorial(telefono),
    });
  }

  const texto = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  agregarMensaje(telefono, "assistant", response.content);
  return texto;
}

// ── Enviar mensaje por Botmaker API ──────────────────────
async function responderBotmaker(contactId, chatChannelId, texto) {
  try {
    await axios.post(
      "https://go.botmaker.com/api/v1.0/message/v3/send",
      {
        chatPlatform: "whatsapp",
        chatChannelId: chatChannelId,
        platformContactId: contactId,
        messageType: "text",
        text: texto,
      },
      {
        headers: {
          "access-token": process.env.BOTMAKER_TOKEN,
          "Content-Type": "application/json",
        },
      }
    );
    console.log(`[Botmaker] Mensaje enviado a ${contactId}`);
  } catch (err) {
    console.error(`[Botmaker] Error al enviar:`, err.response?.data || err.message);
  }
}

// ── Webhook: recibe mensajes de Botmaker ─────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;

    // Extraemos los campos que manda Botmaker
    const contactId = body.contactId;
    const chatChannelId = body.chatChannelId;
    const messages = body.messages || [];

    // Solo procesamos mensajes del usuario
    const mensajeUsuario = messages.find((m) => m.from === "user");
    if (!mensajeUsuario || !mensajeUsuario.message) return;

    const texto = mensajeUsuario.message.trim();
    console.log(`\n[Webhook] ${contactId}: "${texto}"`);

    const respuesta = await procesarMensaje(contactId, texto);
    console.log(`[Claude] Respuesta: "${respuesta}"`);

    await responderBotmaker(contactId, chatChannelId, respuesta);
  } catch (err) {
    console.error("[Webhook] Error:", err.message);
  }
});

// ── Health check ──────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", mensaje: "MVP Cobranzas corriendo" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
