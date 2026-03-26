require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Memoria temporal simple.
// Sirve para pruebas y primera versión.
// Más adelante esto idealmente pasa a Redis o DB.
const conversationState = new Map();

// ==========================
// DETECCIÓN DE INTENCIÓN
// ==========================
function detectIntent(message = '') {
  const text = String(message).toLowerCase();

  if (/cu[aá]ndo.*vence|vencimiento/.test(text)) {
    return 'consulta_vencimiento';
  }

  if (/deuda|saldo/.test(text)) {
    return 'consulta_deuda';
  }

  if (/pagar|pago|medios de pago/.test(text)) {
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
// CONSULTA A DOLIBARR
// ==========================
async function consultarDolibarr(dni) {
  const response = await axios.post(
    process.env.DOLIBARR_ENDPOINT,
    { dni },
    {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DOLIBARR_TOKEN}`
      },
      timeout: 20000
    }
  );

  const raw = response.data || {};

  return {
    found: !!raw.found,
    nombre: raw.nombre ? String(raw.nombre) : '',
    error: raw.error ? String(raw.error) : '',
    total_deuda: raw.data?.total_deuda ? String(raw.data.total_deuda) : '',
    monto_prox_cuota: raw.data?.monto_prox_cuota ? String(raw.data.monto_prox_cuota) : '',
    vencimiento_prox_cuota: raw.data?.vencimiento_prox_cuota ? String(raw.data.vencimiento_prox_cuota) : ''
  };
}

// ==========================
// HEALTHCHECK
// ==========================
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'agente-cobranzas'
  });
});

// ==========================
// ENDPOINT PRINCIPAL
// ==========================
app.post('/api/collections/handle', async (req, res) => {
  console.log('[REQUEST BODY]', req.body);

  try {
    const {
      conversation_id,
      message = '',
      dni = '',
      step
    } = req.body;

    if (!conversation_id) {
      console.log('[RESPONSE]', { action: 'error', reason: 'missing_conversation_id' });
      return res.json({
        action: 'error',
        reply: 'Falta conversation_id'
      });
    }

    // ======================
    // PRIMER MENSAJE
    // ======================
    if (step === 'initial_question') {
      const intent = detectIntent(message);

      console.log('[INTENT DETECTED]', {
        conversation_id,
        message,
        intent
      });

      if (intent === 'handoff') {
        console.log('[RESPONSE]', { action: 'handoff', conversation_id });
        return res.json({
          action: 'handoff',
          reply: 'Voy a derivarte con un asesor.'
        });
      }

      if (!requiresDni(intent)) {
        if (intent === 'medios_pago') {
          console.log('[RESPONSE]', { action: 'reply', conversation_id, intent });
          return res.json({
            action: 'reply',
            reply: 'Puedes pagar por transferencia o tarjeta.'
          });
        }

        console.log('[RESPONSE]', { action: 'reply', conversation_id, intent });
        return res.json({
          action: 'reply',
          reply: 'Puedo ayudarte con deuda, vencimientos o pagos.'
        });
      }

      // Guardar estado para esperar DNI
      conversationState.set(conversation_id, {
        awaiting_dni: true,
        intent,
        original_question: message,
        updated_at: new Date().toISOString()
      });

      console.log('[STATE SAVED]', {
        conversation_id,
        state: conversationState.get(conversation_id)
      });

      console.log('[RESPONSE]', { action: 'ask_dni', conversation_id });
      return res.json({
        action: 'ask_dni'
      });
    }

    // ======================
    // RESPUESTA CON DNI
    // ======================
    if (step === 'dni_response') {
      const state = conversationState.get(conversation_id);

      console.log('[STATE FOUND]', {
        conversation_id,
        state: state || null
      });

      if (!state) {
        console.log('[RESPONSE]', { action: 'error', conversation_id, reason: 'no_pending_state' });
        return res.json({
          action: 'error',
          reply: 'No hay una consulta pendiente.'
        });
      }

      const cleanDni = String(dni).replace(/\D/g, '');

      if (cleanDni.length < 7 || cleanDni.length > 8) {
        console.log('[RESPONSE]', { action: 'error', conversation_id, reason: 'invalid_dni', dni: cleanDni });
        return res.json({
          action: 'error',
          reply: 'DNI inválido'
        });
      }

      const data = await consultarDolibarr(cleanDni);

      console.log('[DOLIBARR RESPONSE]', {
        conversation_id,
        found: data.found,
        nombre: data.nombre,
        total_deuda: data.total_deuda,
        monto_prox_cuota: data.monto_prox_cuota,
        vencimiento_prox_cuota: data.vencimiento_prox_cuota,
        error: data.error
      });

      if (!data.found) {
        conversationState.delete(conversation_id);

        console.log('[STATE DELETED]', { conversation_id });

        console.log('[RESPONSE]', { action: 'reply', conversation_id, reason: 'dni_not_found' });
        return res.json({
          action: 'reply',
          reply: 'No encontré datos con ese DNI.'
        });
      }

      let reply = '';

      if (state.intent === 'consulta_vencimiento') {
        reply = `Tu próxima cuota vence el ${data.vencimiento_prox_cuota} por ${data.monto_prox_cuota}.`;
      } else if (state.intent === 'consulta_deuda') {
        reply = `Tu deuda total es ${data.total_deuda}.`;
      } else {
        reply = 'Pude validar tus datos, pero no identifiqué la consulta pendiente.';
      }

      conversationState.delete(conversation_id);

      console.log('[STATE DELETED]', { conversation_id });

      console.log('[RESPONSE]', {
        action: 'reply',
        conversation_id,
        reply
      });

      return res.json({
        action: 'reply',
        reply
      });
    }

    console.log('[RESPONSE]', { action: 'error', conversation_id, reason: 'unknown_step', step });
    return res.json({
      action: 'error',
      reply: 'Paso no reconocido'
    });
  } catch (err) {
    console.error('[ERROR]', err);

    return res.json({
      action: 'error',
      reply: 'Error interno'
    });
  }
});

app.listen(PORT, () => {
  console.log('Servidor corriendo en puerto ' + PORT);
});
