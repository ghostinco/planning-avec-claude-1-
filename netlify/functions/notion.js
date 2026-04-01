// Fonction Netlify — pont vers Supabase
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_KEY;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS"
};

const supa = async (path, method = 'GET', body = null) => {
  const opts = {
    method,
    headers: {
      'apikey': SUPA_KEY,
      'Authorization': `Bearer ${SUPA_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'return=representation' : ''
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${SUPA_URL}/rest/v1/${path}`, opts);
  const text = await r.text();
  return text ? JSON.parse(text) : {};
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders, body: '' };

  const ok = (data) => ({ statusCode: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const err = (msg, code = 500) => ({ statusCode: code, headers: { ...corsHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: msg }) });

  try {
    const path = event.path.replace('/.netlify/functions/notion', '').replace('/api/notion', '');
    const method = event.httpMethod;
    const body = event.body ? JSON.parse(event.body) : {};
    const params = event.queryStringParameters || {};

    // ── BÉNÉVOLES ──
    if (path === '/bens' && method === 'GET') {
      const data = await supa('bens?select=*&order=created_at');
      return ok({ bens: Array.isArray(data) ? data : [] });
    }
    if (path === '/bens' && method === 'POST') {
      const data = await supa('bens', 'POST', body);
      return ok({ id: Array.isArray(data) ? data[0]?.id : data?.id });
    }
    if (path.startsWith('/bens/') && method === 'PATCH') {
      const id = path.split('/')[2];
      await supa(`bens?id=eq.${id}`, 'PATCH', body);
      return ok({ ok: true });
    }
    if (path.startsWith('/bens/') && method === 'DELETE') {
      const id = path.split('/')[2];
      await supa(`bens?id=eq.${id}`, 'DELETE');
      return ok({ ok: true });
    }

    // ── CRÉNEAUX ──
    if (path === '/slots' && method === 'GET') {
      const data = await supa('slots?select=*&order=created_at');
      return ok({ slots: Array.isArray(data) ? data : [] });
    }
    if (path === '/slots' && method === 'POST') {
      const data = await supa('slots', 'POST', body);
      return ok({ id: Array.isArray(data) ? data[0]?.id : data?.id });
    }
    if (path.startsWith('/slots/') && method === 'PATCH') {
      const id = path.split('/')[2];
      await supa(`slots?id=eq.${id}`, 'PATCH', body);
      return ok({ ok: true });
    }
    if (path.startsWith('/slots/') && method === 'DELETE') {
      const id = path.split('/')[2];
      await supa(`slots?id=eq.${id}`, 'DELETE');
      await supa(`assigns?slot_id=eq.${id}`, 'DELETE');
      return ok({ ok: true });
    }

    // ── ASSIGNATIONS ──
    if (path === '/assigns' && method === 'GET') {
      const data = await supa('assigns?select=*');
      return ok({ assigns: Array.isArray(data) ? data : [] });
    }
    if (path === '/assigns' && method === 'POST') {
      const data = await supa('assigns', 'POST', body);
      return ok({ id: Array.isArray(data) ? data[0]?.id : data?.id });
    }
    if (path.startsWith('/assigns/') && method === 'DELETE') {
      const id = path.split('/')[2];
      await supa(`assigns?id=eq.${id}`, 'DELETE');
      return ok({ ok: true });
    }
    // Supprimer par slot+ben
    if (path === '/assigns/remove' && method === 'POST') {
      const { slot_id, ben_id } = body;
      await supa(`assigns?slot_id=eq.${slot_id}&ben_id=eq.${ben_id}`, 'DELETE');
      return ok({ ok: true });
    }

    return err('Route inconnue: ' + path, 404);
  } catch (e) {
    console.error(e);
    return err(e.message);
  }
};
