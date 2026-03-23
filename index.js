const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const DOLIBARR_ENDPOINT = 'https://fidinmo.com.ar/fidinmo/htdocs/api/api_bot_cobranzas.php';
const DOLIBARR_TOKEN = 'BOT_TOKEN_SPAZIOS_2026';

const conversaciones = {};

const tools = [
  {
    name: 'consultar_cliente',
    description: 'Consulta la base de datos para obtener información de un cliente por su DNI. Usá esta herramienta cuando el cliente quiera saber su deuda, próxima cuota, vencimiento, o cuando necesites confirmar si un pago fue acreditado.',
    input_schema: {
      type: 'object',
      properties: {
        dni: {
          type: 'string',
          description: 'El DNI del cliente, solo números sin puntos ni espacios'
        }
      },
      required: ['dni']
    }
  }
];

async function consultarCliente(dni) {
  try {
    const response = await fetch(DOLIBARR_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DOLIBARR_TOKEN}`
      },
      body: JSON.stringify({ dni }),
    });
    const data = await response.json();
    if (!data.found) {
      return { encontrado: false, mensaje: 'No se encontró ningún cliente con ese DNI.' };
    }
    return {
      encontrado: true,
      nombre: data.nombre || '',
      total_deuda: data.data?.total_deuda || '',
      monto_prox_cuota: data.data?.monto_prox_cuota || '',
      vencimiento_prox_cuota: data.data?.vencimiento_prox_cuota || '',
    };
  } catch (err) {
    return { encontrado: false, mensaje: 'Error al consultar la base de datos: ' + err.message };
  }
}

const SYSTEM_PROMPT = `Siempre respondés en español, sin excepción.

Sos un asistente de cobranzas de Spazios. Sos autónomo — tomás decisiones solo basándote en lo que el cliente dice y en los datos reales de la base de datos.

Tenés acceso a una herramienta llamada consultar_cliente que recibe un DNI y devuelve los datos reales del cliente: nombre, deuda total, monto y fecha de próxima cuota. Usala cuando necesites información personalizada.

Cómo actuás ante cada tipo de consulta:

CONSULTAS GENERALES (no necesitan DNI):
- Medios de pago, dónde pagar, cómo pagar → respondés directamente con la información general.
- Plazos de acreditación → informás que los pagos demoran hasta 48 horas hábiles.
- El cliente dice que pagó y no se refleja → primero preguntás si fue dentro de las últimas 48 horas hábiles. Si sí, le decís que espere. Si no, pedís el DNI para consultar.

CONSULTAS PERSONALIZADAS (necesitan DNI):
- Cuánto debo, mi deuda, mis cuotas, estado de cuenta, libre deuda, refinanciación → pedís el DNI y usás la herramienta consultar_cliente para traer los datos reales.
- Una vez que tenés los datos, respondés con la información real: nombre, deuda, próxima cuota y vencimiento.
- Si el cliente no está en la base de datos, lo informás amablemente y ofrecés derivarlo a un representante.

MENSAJES AMBIGUOS:
- "hola", "consulta", "ayuda", "tengo un problema" → preguntás: "¿Tu consulta es sobre un pago que realizaste, tu deuda actual, los medios de pago disponibles o algo diferente?"

DERIVACIÓN A HUMANO:
- Reclamos reiterados, enojo fuerte, situaciones excepcionales, o cuando el cliente pide hablar con una persona → respondés: "Entiendo tu situación. Voy a conectarte con un representante que pueda ayudarte." y terminás con la palabra DERIVAR en una línea aparte.

CIERRE DE CONVERSACIÓN:
- Cuando la consulta quedó resuelta y el cliente se despide → respondés con un cierre amable y terminás con la palabra FIN en una línea aparte.

Reglas:
- Nunca inventés montos, fechas ni políticas.
- Nunca confirmés un pago sin consultarlo en la base de datos.
- Nunca pedís DNI si la consulta puede responderse con información general.
- Tono: breve, claro, empático y profesional. Una idea por mensaje.`;

async function procesarMensaje(sessionId, mensajeUsuario) {
  if (!conversaciones[sessionId]) {
    conversaciones[sessionId] = [];
  }

  conversaciones[sessionId].push({
    role: 'user',
    content: mensajeUsuario
  });

  let response = await anthropic.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools,
    messages: conversaciones[sessionId],
  });

  while (response.stop_reason === 'tool_use') {
    const toolUse = response.content.find(b => b.type === 'tool_use');
    const toolResult = await consultarCliente(toolUse.input.dni);

    conversaciones[sessionId].push({
      role: 'assistant',
      content: response.content
    });

    conversaciones[sessionId].push({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: JSON.stringify(toolResult)
      }]
    });

    response = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools,
      messages: conversaciones[sessionId],
    });
  }

  const textoRespuesta = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  conversaciones[sessionId].push({
    role: 'assistant',
    content: textoRespuesta
  });

  const derivar = textoRespuesta.includes('DERIVAR');
  const fin = textoRespuesta.includes('FIN');

  if (fin || derivar) {
    delete conversaciones[sessionId];
  }

  const respuestaLimpia = textoRespuesta
    .replace(/\nDERIVAR/g, '')
    .replace(/\nFIN/g, '')
    .trim();

  return {
    respuesta: respuestaLimpia,
    derivar,
    fin
  };
}

app.post('/webhook', async (req, res) => {
  try {
    const { sessionId, mensaje } = req.body;

    if (!sessionId || !mensaje) {
      return res.status(400).json({ error: 'Faltan sessionId o mensaje' });
    }

    const resultado = await procesarMensaje(sessionId, mensaje);
    res.json(resultado);

  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Agente de cobranzas corriendo en puerto ${PORT}`);
});
