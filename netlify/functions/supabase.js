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
  const jourMap = {'lundi':'Lundi','mardi':'Mardi','mercredi':'Mercredi','jeudi':'Jeudi','vendredi':'Vendredi','samedi':'Samedi','dimanche':'Dimanche'};
  const moisMap = {'janvier':'janvier','fevrier':'février','mars':'mars','avril':'avril','mai':'mai','juin':'juin','juillet':'juillet','aout':'août','septembre':'septembre','octobre':'octobre','novembre':'novembre','decembre':'décembre','février':'février','août':'août'};
  const moisNum = {'janvier':1,'fevrier':2,'mars':3,'avril':4,'mai':5,'juin':6,'juillet':7,'aout':8,'septembre':9,'octobre':10,'novembre':11,'decembre':12,'février':2,'août':8};
  const norm = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim();
  // Jours du festival hardcodés pour matcher les plages
  const FESTIVAL_DAYS = [
    {day:17,month:6,lbl:'Mercredi 17 juin'},
    {day:18,month:6,lbl:'Jeudi 18 juin'},
    {day:19,month:6,lbl:'Vendredi 19 juin'},
    {day:20,month:6,lbl:'Samedi 20 juin'},
  ];
  // Détecter format "du X au Y" ou "du X juin au Y juin"
  const rangMatch = norm(text).match(/du\s+(\d+)\s*(?:(\w+))?\s+au\s+(\d+)\s*(?:(\w+))?/);
  if (rangMatch) {
    const d1=parseInt(rangMatch[1]), d2=parseInt(rangMatch[3]);
    return FESTIVAL_DAYS.filter(j=>j.day>=d1&&j.day<=d2).map(j=>j.lbl);
  }
  // Format liste standard
  return text.split(',').map(s => s.trim()).filter(Boolean).map(s => {
    const parts = s.trim().split(/\s+/);
    let jourSem='', day=0, monthName='';
    for (const p of parts) {
      const n = norm(p);
      if (jourMap[n]) jourSem = jourMap[n];
      else if (!isNaN(parseInt(p)) && parseInt(p) > 0 && parseInt(p) <= 31) day = parseInt(p);
      else if (moisMap[n]) monthName = moisMap[n];
    }
    if (day && monthName && jourSem) return `${jourSem} ${day} ${monthName}`;
    if (day && monthName) return `${day} ${monthName}`;
    // Fallback : chercher si un jour du festival est mentionné
    const found = FESTIVAL_DAYS.find(j=>s.includes(String(j.day)));
    return found ? found.lbl : null;
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
  const ok = (data) => ({ statusCode: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store, no-cache, must-revalidate' }, body: JSON.stringify(data) });
  const err = (msg, code = 500) => ({ statusCode: code, headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify({ error: msg }) });

  try {
    const path = event.path.replace('/.netlify/functions/supabase','').replace('/api/supabase','');
    const method = event.httpMethod;
    const body = event.body ? JSON.parse(event.body) : {};
    const params = event.queryStringParameters || {};

    // DEBUG SHEETS — retourne les données brutes
    if (path === '/debug-sheets' && method === 'POST') {
      const { sheet_id } = body;
      const token = await getGoogleToken();
      const sr = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheet_id}/values/A1:Z10?valueRenderOption=FORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await sr.json();
      const rows = data.values || [];
      const headers = rows[0]||[];
      // Trouver col dispos
      const norm = h => String(h).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim();
      const cDi = headers.findIndex(h => ['disponible','dispo','present','quand'].some(k=>norm(h).includes(k)));
      const cP = headers.findIndex(h => h==='Prénom'||norm(h).startsWith('prenom'));
      const cN = headers.findIndex(h => norm(h)==='nom');
      // Montrer les 3 premières lignes avec parseDispos
      const samples = rows.slice(1,4).map(r=>({
        prenom: r[cP], nom: r[cN],
        raw_dispo: r[cDi],
        parsed: parseDispos(String(r[cDi]||''))
      }));
      return ok({ headers, cDi, cP, cN, samples });
    }

    // SYNC GOOGLE SHEETS
    if (path === '/sync-sheets' && method === 'POST') {
      const { sheet_id, event_id } = body;
      if (!sheet_id) return err('sheet_id manquant');
      if (!GOOGLE_SERVICE_KEY) return err('GOOGLE_SERVICE_KEY non configure');
      const token = await getGoogleToken();
      const sr = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheet_id}/values/A1:Z500?valueRenderOption=FORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const sheetsData = await sr.json();
      if (sheetsData.error) return err('Erreur Sheets: ' + sheetsData.error.message);
      const rows = sheetsData.values || [];
      if (rows.length < 2) return ok({ added:0, updated:0, skipped:0 });
      const headers = rows[0].map(h => String(h).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim());
      // Détection simple et fiable
      const col = (kws) => headers.findIndex(h => kws.some(k => h.includes(k)));
      // Prénom : index exact de 'prenom' (sans 'nom' seul)
      const cP = headers.findIndex(h => h==='prenom' || h.startsWith('prenom') || h==='first name' || h==='firstname');
      const cGenre = col(['genre','gender','sexe','sex']);
      // Nom : chercher 'nom' mais pas dans 'prenom'
      const cN = headers.findIndex((h,i) => i !== cP && (h==='nom' || h==='last name' || h==='lastname' || h==='surname'));
      const cD = col(['naissance','birth','ddn']); const cT = col(['telephone','tel','phone','mobile','+41']);
      const cTa = col(['taille','t-shirt','tshirt','shirt']); const cDi = col(['disponible','dispo','present','quand']);
      const cR = col(['remarque','comment','note']);
      const cE = col(['email','mail','courriel']);
      if (cP===-1||cN===-1) return err('Colonnes Prenom/Nom introuvables');
      const existing = await supa(`bens?event_id=eq.${event_id}&select=*`);
      // Normaliser : minuscules + supprimer accents pour matching robuste
      const normStr = s => String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim();
      const benMap = {};
      (Array.isArray(existing)?existing:[]).forEach(b=>{
        benMap[normStr(b.nom)+' '+normStr(b.prenom)]=b;
        benMap[normStr(b.prenom)+' '+normStr(b.nom)]=b;
      });
      let added=0,updated=0,skipped=0;
      const ops=[];
      for (const row of rows.slice(1)) {
        const prenom=String(row[cP]||'').trim(); const nom=String(row[cN]||'').trim();
        if (!prenom&&!nom){skipped++;continue;}
        const ddn=cD>=0?parseDDN(row[cD]):'';
        const tel=cT>=0?String(row[cT]||'').trim():'';
        const taille=cTa>=0?String(row[cTa]||'').trim():'';
        const dispos=cDi>=0?parseDispos(String(row[cDi]||'')):[];
        const rmq=cR>=0?String(row[cR]||'').trim():'';
        const email=cE>=0?String(row[cE]||'').trim():'';
        const genre_raw=cGenre>=0?String(row[cGenre]||'').trim().toLowerCase():'';
        const genre=genre_raw.includes('f')||genre_raw.includes('femme')?'F':genre_raw.includes('m')||genre_raw.includes('homme')?'M':'';
        const key1=normStr(nom)+' '+normStr(prenom);
        const key2=normStr(prenom)+' '+normStr(nom);
        const b=benMap[key1]||benMap[key2];
        if (b) {
          const upd={};
          if(ddn&&(!b.ddn||b.ddn===''))upd.ddn=ddn;
          if(tel&&(!b.tel||b.tel===''))upd.tel=tel;
          if(email)upd.email=email;
          if(taille)upd.taille=taille;
          if(dispos.length>0)upd.dispos=dispos;
          if(rmq&&(!b.rmq||b.rmq===''))upd.rmq=rmq;
          if(genre&&!b.genre)upd.genre=genre;
          // Ne jamais écraser un type_ben défini manuellement
          if(Object.keys(upd).length>0) ops.push({type:'patch',id:b.id,data:upd});
          else skipped++;
        } else {
          ops.push({type:'post',data:{prenom,nom,ddn,tel,taille,dispos,rmq,email,genre:genre||'',sec:'Non défini',poste:'SPF',type:'rotatif',acces:[],type_ben:null,roles:[],event_id}});
        }
      }
      // Exécuter par vrais lots séquentiels de 5
      for(let i=0;i<ops.length;i+=5){
        await Promise.all(ops.slice(i,i+5).map(async op=>{
          try{
            if(op.type==='patch'){await supa(`bens?id=eq.${op.id}`,'PATCH',op.data);updated++;}
            else{await supa('bens','POST',op.data);added++;}
          }catch(e){console.error(e);skipped++;}
        }));
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
    if (path.startsWith('/assigns/')&&method==='PATCH'){const id=path.split('/')[2];await supa(`assigns?id=eq.${id}`,'PATCH',body);return ok({ok:true});}
    if (path==='/assigns/remove'&&method==='POST'){const{slot_id,ben_id}=body;await supa(`assigns?slot_id=eq.${slot_id}&ben_id=eq.${ben_id}`,'DELETE');return ok({ok:true});}

    return err('Route inconnue: '+path,404);
  } catch(e){console.error(e);return err(e.message);}
};
