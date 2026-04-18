// Fonction Netlify — pont vers Supabase + Google Sheets sync
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_KEY;
const GOOGLE_SERVICE_KEY = process.env.GOOGLE_SERVICE_KEY;

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

async function getGoogleToken() {
  const key = JSON.parse(GOOGLE_SERVICE_KEY);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  };
  const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = `${b64(header)}.${b64(payload)}`;
  const crypto = require('crypto');
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(unsigned);
  const signature = sign.sign(key.private_key, 'base64url');
  const jwt = `${unsigned}.${signature}`;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });
  const data = await r.json();
  if (!data.access_token) throw new Error('Token Google echoue: ' + JSON.stringify(data));
  return data.access_token;
}

function parseDispos(text) {
  if (!text) return [];
  const moisMap = {'janvier':1,'fevrier':2,'mars':3,'avril':4,'mai':5,'juin':6,'juillet':7,'aout':8,'septembre':9,'octobre':10,'novembre':11,'decembre':12,'février':2,'août':8};
  return text.split(',').map(s => s.trim()).filter(Boolean).map(s => {
    const parts = s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(' ');
    for (let i = 0; i < parts.length - 1; i++) {
      const day = parseInt(parts[i]);
      const monthKey = parts[i+1];
      const month = moisMap[monthKey];
      if (!isNaN(day) && month) {
        const orig = s.trim().split(' ');
        const monthName = orig.find(p => moisMap[p.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')] === month) || monthKey;
        return `${day} ${monthName.charAt(0).toUpperCase()+monthName.slice(1).toLowerCase()}`;
      }
    }
    return null;
  }).filter(Boolean);
}

function parseDDN(val) {
  if (!val) return '';
  const s = String(val).trim();
  // Format DD/MM/YYYY ou DD.MM.YYYY
  const m = s.match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  // Format YYYY-MM-DD
  if (s.match(/^\d{4}-\d{2}-\d{2}$/)) return s;
  // Timestamp Excel
  const n = parseFloat(val);
  if (!isNaN(n) && n > 10000) {
    const d = new Date(Math.round((n - 25569) * 86400 * 1000));
    if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
  }
  return '';
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders, body: '' };
  const ok = (data) => ({ statusCode: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const err = (msg, code = 500) => ({ statusCode: code, headers: { ...corsHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: msg }) });

  try {
    const path = event.path.replace('/.netlify/functions/supabase','').replace('/api/supabase','');
    const method = event.httpMethod;
    const body = event.body ? JSON.parse(event.body) : {};
    const params = event.queryStringParameters || {};

    // SYNC GOOGLE SHEETS
    if (path === '/sync-sheets' && method === 'POST') {
      const { sheet_id, event_id } = body;
      if (!sheet_id) return err('sheet_id manquant');
      if (!GOOGLE_SERVICE_KEY) return err('GOOGLE_SERVICE_KEY non configure');
      const token = await getGoogleToken();
      const sr = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheet_id}/values/A1:Z500`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const sheetsData = await sr.json();
      if (sheetsData.error) return err('Erreur Sheets: ' + sheetsData.error.message);
      const rows = sheetsData.values || [];
      if (rows.length < 2) return ok({ added:0, updated:0, skipped:0 });
      const headers = rows[0].map(h => String(h).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim());
      const col = (kws) => headers.findIndex(h => kws.some(k => h.includes(k)));
      const cP = col(['prenom','first']); const cN = col(['nom','last','name','surname']);
      const cD = col(['naissance','birth','ddn']); const cT = col(['telephone','tel','phone','mobile','+41']);
      const cTa = col(['taille','t-shirt','tshirt','shirt']); const cDi = col(['disponible','dispo','present','quand']);
      const cR = col(['remarque','comment','note']);
      if (cP===-1||cN===-1) return err('Colonnes Prenom/Nom introuvables');
      const existing = await supa(`bens?event_id=eq.${event_id}&select=*`);
      const benMap = {};
      (Array.isArray(existing)?existing:[]).forEach(b=>{
        // Indexer dans les deux sens pour matcher peu importe l'ordre
        benMap[(b.nom+' '+b.prenom).toLowerCase().trim()]=b;
        benMap[(b.prenom+' '+b.nom).toLowerCase().trim()]=b;
      });
      let added=0,updated=0,skipped=0;
      for (const row of rows.slice(1)) {
        const prenom=String(row[cP]||'').trim(); const nom=String(row[cN]||'').trim();
        if (!prenom&&!nom){skipped++;continue;}
        const ddn=cD>=0?parseDDN(row[cD]):'';
        const tel=cT>=0?String(row[cT]||'').trim():'';
        const taille=cTa>=0?String(row[cTa]||'').trim():'';
        const dispos=cDi>=0?parseDispos(String(row[cDi]||'')):[];
        const rmq=cR>=0?String(row[cR]||'').trim():'';
        // Chercher dans les deux sens (nom+prenom et prenom+nom)
        const key1=(nom+' '+prenom).toLowerCase().trim();
        const key2=(prenom+' '+nom).toLowerCase().trim();
        const b=benMap[key1]||benMap[key2];
        try {
          if (b) {
            const upd={};
            if (ddn&&!b.ddn)upd.ddn=ddn; if(tel&&!b.tel)upd.tel=tel;
            if(taille)upd.taille=taille; if(dispos.length>0)upd.dispos=dispos;
            if(rmq&&!b.rmq)upd.rmq=rmq;
            if(Object.keys(upd).length>0)await supa(`bens?id=eq.${b.id}`,'PATCH',upd);
            updated++;
          } else {
            await supa('bens','POST',{prenom,nom,ddn,tel,taille,dispos,rmq,email:'',sec:'Parking',poste:'P1',type:'rotatif',acces:[],type_ben:null,roles:[],event_id});
            added++;
          }
        } catch(e){console.error(e);skipped++;}
      }
      return ok({added,updated,skipped,total:rows.length-1});
    }

    // EVENEMENTS
    if (path==='/events'&&method==='GET'){const data=await supa('events?select=*&order=created_at');return ok({events:Array.isArray(data)?data:[]});}
    if (path==='/events'&&method==='POST'){const data=await supa('events','POST',body);return ok({id:Array.isArray(data)?data[0]?.id:data?.id,event:Array.isArray(data)?data[0]:data});}
    if (path.startsWith('/events/')&&method==='PATCH'){const id=path.split('/')[2];await supa(`events?id=eq.${id}`,'PATCH',body);return ok({ok:true});}
    if (path.startsWith('/events/')&&method==='DELETE'){const id=path.split('/')[2];await supa(`events?id=eq.${id}`,'DELETE');return ok({ok:true});}

    // BENEVOLES
    if (path==='/bens'&&method==='GET'){const eid=params.event_id;const data=await supa(eid?`bens?event_id=eq.${eid}&select=*&order=created_at`:'bens?select=*&order=created_at');return ok({bens:Array.isArray(data)?data:[]});}
    if (path==='/bens'&&method==='POST'){const data=await supa('bens','POST',body);return ok({id:Array.isArray(data)?data[0]?.id:data?.id});}
    if (path.startsWith('/bens/')&&method==='PATCH'){const id=path.split('/')[2];await supa(`bens?id=eq.${id}`,'PATCH',body);return ok({ok:true});}
    if (path.startsWith('/bens/')&&method==='DELETE'){const id=path.split('/')[2];await supa(`bens?id=eq.${id}`,'DELETE');return ok({ok:true});}

    // CRENEAUX
    if (path==='/slots'&&method==='GET'){const eid=params.event_id;const data=await supa(eid?`slots?event_id=eq.${eid}&select=*&order=created_at`:'slots?select=*&order=created_at');return ok({slots:Array.isArray(data)?data:[]});}
    if (path==='/slots'&&method==='POST'){const data=await supa('slots','POST',body);return ok({id:Array.isArray(data)?data[0]?.id:data?.id});}
    if (path.startsWith('/slots/')&&method==='PATCH'){const id=path.split('/')[2];await supa(`slots?id=eq.${id}`,'PATCH',body);return ok({ok:true});}
    if (path.startsWith('/slots/')&&method==='DELETE'){const id=path.split('/')[2];await supa(`slots?id=eq.${id}`,'DELETE');await supa(`assigns?slot_id=eq.${id}`,'DELETE');return ok({ok:true});}

    // ASSIGNATIONS
    if (path==='/assigns'&&method==='GET'){const data=await supa('assigns?select=*');return ok({assigns:Array.isArray(data)?data:[]});}
    if (path==='/assigns'&&method==='POST'){const data=await supa('assigns','POST',body);return ok({id:Array.isArray(data)?data[0]?.id:data?.id});}
    if (path.startsWith('/assigns/')&&method==='DELETE'){const id=path.split('/')[2];await supa(`assigns?id=eq.${id}`,'DELETE');return ok({ok:true});}
    if (path==='/assigns/remove'&&method==='POST'){const{slot_id,ben_id}=body;await supa(`assigns?slot_id=eq.${slot_id}&ben_id=eq.${ben_id}`,'DELETE');return ok({ok:true});}

    return err('Route inconnue: '+path,404);
  } catch(e){console.error(e);return err(e.message);}
};
