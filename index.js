require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// memoria simple (luego se reemplaza por DB)
const conversationState = new Map();

// ==========================
// 🔹 DETECCIÓN DE INTENCIÓN
// ==========================
function detectIntent(message = '') {
  const text = message.toLowerCase();

  if (/cu[aá]ndo.*vence|vencimiento/.test(text)) {
    return 'consulta_vencimiento';
  }

  if (/deuda|saldo/.test(text)) {
    return 'consulta_deuda';
  }

  if (/pagar|pago/.test(text)) {
    return 'medios_pago';
  }

  if (/asesor|humano/.test(text)) {
    return 'handoff';
  }

  return 'general';
}

function requiresDni(intent) {
  return ['consulta_vencimiento', 'consulta_deuda'].includes(intent);
}

// ==========================
// 🔹 DOLIBARR
// ==========================
async function consultarDolibarr(dni) {
  const response = await axios.post(
    process.env.DOLIBARR_ENDPOINT,
    { dni },
    {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DOLIBARR_TOKEN}`
      }
    }
  );

  const raw = response.data || {};

  return {
    found: !!raw.found,
    nombre: raw.nombre || '',
    total_deuda: raw.data?.total_deuda || '',
    monto_prox_cuota: raw.data?.monto_prox_cuota || '',
    vencimiento_prox_cuota: raw.data?.vencimiento_prox_cuota || ''
  };
}

// ==========================
// 🔹 ENDPOINT PRINCIPAL
// ==========================
app.post('/api/collections/handle', async (req, res) => {
  try {
    const { conversation_id, message = '', dni = '', step } = req.body;

    if (!conversation_id) {
      return res.json({
        action: 'error',
        reply: 'Falta conversation_id'
      });
    }

    // ======================
    // 🔹 PRIMER MENSAJE
    // ======================
    if (step === 'initial_question') {
      const intent = detectIntent(message);

      if (!requiresDni(intent)) {
        if (intent === 'medios_pago') {
          return res.json({
            action: 'reply',
            reply: 'Puedes pagar por transferencia o tarjeta.'
          });
        }

        return res.json({
          action: 'reply',
          reply: 'Puedo ayudarte con deuda, vencimientos o pagos.'
        });
      }

      // guardar estado
      conversationState.set(conversation_id, {
        awaiting_dni: true,
        intent,
        original_question: message
      });

      return res.json({ action: 'ask_dni' });
    }

    // ======================
    // 🔹 RESPUESTA DNI
    // ======================
    if (step === 'dni_response') {
      const state = conversationState.get(conversation_id);

      if (!state) {
        return res.json({
          action: 'error',
          reply: 'No hay una consulta pendiente.'
        });
      }

      const cleanDni = String(dni).replace(/\D/g, '');

      if (cleanDni.length < 7) {
        return res.json({
          action: 'error',
          reply: 'DNI inválido'
        });
      }

      const data = await consultarDolibarr(cleanDni);

      if (!data.found) {
        return res.json({
          action: 'reply',
          reply: 'No encontré datos con ese DNI.'
        });
      }

      let reply = '';

      if (state.intent === 'consulta_vencimiento') {
        reply = `Tu próxima cuota vence el ${data.vencimiento_prox_cuota} por ${data.monto_prox_cuota}.`;
      }

      if (state.intent === 'consulta_deuda') {
        reply = `Tu deuda total es ${data.total_deuda}.`;
      }

      conversationState.delete(conversation_id);

      return res.json({
        action: 'reply',
        reply
      });
    }

    return res.json({
      action: 'error',
      reply: 'Paso no reconocido'
    });

  } catch (err) {
    return res.json({
      action: 'error',
      reply: 'Error interno'
    });
  }
});

// ==========================
app.listen(PORT, () => {
  console.log('Servidor corriendo en puerto ' + PORT);
});
