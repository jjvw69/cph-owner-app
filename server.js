'use strict';
/**
 * cph-owner-app — standalone server for the Caribbean Paradise Homes
 * Owner App + Property-Management Console. Completely separate from
 * cph-my-stay (guest app + concierge console).
 *
 * Real, persistent features behind a 3-user login (ivonna, jan, maria):
 *   - Meter readings  (/readings)
 *   - Work orders     (/work-orders)
 * Access codes come from environment variables (never committed). Data is
 * stored as JSON on a persistent disk when mounted (DATA_DIR, default
 * /var/data), falling back to ./ if not.
 */
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;

// ---- users & auth -------------------------------------------------------
const USERS = {
  ivonna: process.env.CODE_IVONNA || 'ivonna-demo',
  jan:    process.env.CODE_JAN    || 'jan-demo',
  maria:  process.env.CODE_MARIA  || 'maria-demo'
};
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
const COOKIE = 'cph_owner_sess';

function sign(v){ return crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('base64url'); }
function makeToken(user){ const body = user + '.' + Date.now(); return body + '.' + sign(body); }
function verifyToken(tok){
  if(!tok) return null;
  const parts = String(tok).split('.');
  if(parts.length !== 3) return null;
  const [user, ts, mac] = parts;
  if(sign(user + '.' + ts) !== mac) return null;
  if(!USERS[user]) return null;
  if(Date.now() - Number(ts) > 30*24*3600*1000) return null;
  return user;
}
function parseCookies(req){
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('='); if(i < 0) return;
    out[p.slice(0,i).trim()] = decodeURIComponent(p.slice(i+1).trim());
  });
  return out;
}
function currentUser(req){ return verifyToken(parseCookies(req)[COOKIE]); }

// ---- generic JSON store (persistent disk if available) ------------------
const DATA_DIR = process.env.DATA_DIR || '/var/data';
let BASE_DIR = DATA_DIR;
try { fs.mkdirSync(DATA_DIR, { recursive: true }); }
catch(e) { BASE_DIR = __dirname; } // fallback: ephemeral
function storePath(name){ return path.join(BASE_DIR, name + '.json'); }
function loadStore(name){
  try { return JSON.parse(fs.readFileSync(storePath(name), 'utf8')); }
  catch(e){ return []; }
}
function saveStore(name, arr){
  try { fs.writeFileSync(storePath(name), JSON.stringify(arr, null, 2)); return true; }
  catch(e){ return false; }
}
function newId(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,6); }

const VILLAS = [
  'Villa Cajuiles 12','Villa Vistamar 8','Villa Barranca Este 24',
  'Villa Las Colinas 31','Villa Punta Aguila 5','Villa Los Naranjos 78'
];
const WO_STATUSES = ['Open','Quoting','Approved','Parts ordered','Scheduled','Done'];

// ---- helpers ------------------------------------------------------------
const TYPES = {
  '.html':'text/html; charset=utf-8', '.js':'application/javascript; charset=utf-8',
  '.jsx':'application/javascript; charset=utf-8', '.css':'text/css; charset=utf-8',
  '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp',
  '.svg':'image/svg+xml', '.ico':'image/x-icon'
};
const PAGES = {
  '/':'owner.html', '/owner':'owner.html',
  '/property-console':'property-console.html',
  '/owner-design':'owner-design.html',
  '/readings':'readings.html',
  '/work-orders':'work-orders.html'
};
const STATIC_WHITELIST = new Set(['support.js','doc-page.js','ios-frame.jsx']);

function sendFile(res, file){
  fs.readFile(path.join(__dirname, file), (err, buf) => {
    if(err){ res.writeHead(404, {'Content-Type':'text/plain'}); return res.end('Not found'); }
    res.writeHead(200, {'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control':'no-cache'});
    res.end(buf);
  });
}
function sendJSON(res, code, obj, headers){
  res.writeHead(code, Object.assign({'Content-Type':'application/json; charset=utf-8'}, headers||{}));
  res.end(JSON.stringify(obj));
}
function readBody(req){
  return new Promise((resolve) => {
    let b=''; req.on('data', c => { b+=c; if(b.length>1e6) req.destroy(); });
    req.on('end', () => { try{ resolve(JSON.parse(b||'{}')); }catch(e){ resolve({}); } });
  });
}
function num(v){ return (v === '' || v == null) ? null : Number(v); }

// ---- server -------------------------------------------------------------
http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];
  const method = req.method;

  if(url === '/healthz'){ res.writeHead(200,{'Content-Type':'text/plain'}); return res.end('ok'); }

  // ---- auth ----
  if(url === '/api/login' && method === 'POST'){
    const { name, code } = await readBody(req);
    const u = String(name||'').toLowerCase().trim();
    if(USERS[u] && code && String(code) === USERS[u]){
      const tok = makeToken(u);
      return sendJSON(res, 200, { ok:true, user:u }, {
        'Set-Cookie': COOKIE+'='+encodeURIComponent(tok)+'; Path=/; HttpOnly; SameSite=Lax; Max-Age='+(30*24*3600)
      });
    }
    return sendJSON(res, 401, { ok:false, error:'Invalid name or code' });
  }
  if(url === '/api/logout' && method === 'POST'){
    return sendJSON(res, 200, { ok:true }, { 'Set-Cookie': COOKIE+'=; Path=/; HttpOnly; Max-Age=0' });
  }
  if(url === '/api/me'){
    const u = currentUser(req);
    return u ? sendJSON(res, 200, { user:u, villas:VILLAS, wo_statuses:WO_STATUSES })
             : sendJSON(res, 401, { error:'not signed in' });
  }

  // Everything past here needs auth.
  const isApi = url.indexOf('/api/') === 0;
  const user = currentUser(req);
  if(isApi && !user) return sendJSON(res, 401, { error:'not signed in' });

  // ---- meter readings ----
  if(url === '/api/readings' && method === 'GET'){
    return sendJSON(res, 200, { readings: loadStore('readings') });
  }
  if(url === '/api/readings' && method === 'POST'){
    const b = await readBody(req);
    const villa = String(b.villa||'').trim();
    if(VILLAS.indexOf(villa) < 0) return sendJSON(res, 400, { error:'unknown villa' });
    const elec = num(b.electricity_kwh), water = num(b.water_gal);
    if(elec == null && water == null) return sendJSON(res, 400, { error:'enter at least one reading' });
    if((elec != null && !isFinite(elec)) || (water != null && !isFinite(water)))
      return sendJSON(res, 400, { error:'readings must be numbers' });
    const rows = loadStore('readings');
    const entry = { id:newId(), villa, electricity_kwh:elec, water_gal:water,
      note:String(b.note||'').slice(0,300), user, ts:new Date().toISOString() };
    rows.unshift(entry);
    const ok = saveStore('readings', rows);
    return sendJSON(res, ok?200:500, ok ? { ok:true, entry } : { error:'could not save' });
  }
  if(url === '/api/readings/delete' && method === 'POST'){
    const { id } = await readBody(req);
    const rows = loadStore('readings').filter(r => r.id !== id);
    const ok = saveStore('readings', rows);
    return sendJSON(res, ok?200:500, ok ? { ok:true } : { error:'could not save' });
  }

  // ---- work orders ----
  if(url === '/api/workorders' && method === 'GET'){
    return sendJSON(res, 200, { workorders: loadStore('workorders'), statuses: WO_STATUSES });
  }
  if(url === '/api/workorders' && method === 'POST'){
    const b = await readBody(req);
    const villa = String(b.villa||'').trim();
    const title = String(b.title||'').trim();
    if(VILLAS.indexOf(villa) < 0) return sendJSON(res, 400, { error:'unknown villa' });
    if(!title) return sendJSON(res, 400, { error:'title required' });
    const cost = num(b.cost);
    if(cost != null && !isFinite(cost)) return sendJSON(res, 400, { error:'cost must be a number' });
    const status = WO_STATUSES.indexOf(b.status) >= 0 ? b.status : 'Open';
    const rows = loadStore('workorders');
    const entry = { id:newId(), villa, title, vendor:String(b.vendor||'').slice(0,120),
      cost, status, note:String(b.note||'').slice(0,400),
      created_by:user, created_ts:new Date().toISOString(),
      updated_by:user, updated_ts:new Date().toISOString() };
    rows.unshift(entry);
    const ok = saveStore('workorders', rows);
    return sendJSON(res, ok?200:500, ok ? { ok:true, entry } : { error:'could not save' });
  }
  if(url === '/api/workorders/update' && method === 'POST'){
    const b = await readBody(req);
    const rows = loadStore('workorders');
    const wo = rows.find(x => x.id === b.id);
    if(!wo) return sendJSON(res, 404, { error:'not found' });
    if(b.status != null){
      if(WO_STATUSES.indexOf(b.status) < 0) return sendJSON(res, 400, { error:'unknown status' });
      wo.status = b.status;
    }
    if(b.note != null) wo.note = String(b.note).slice(0,400);
    if(b.cost !== undefined){ const c = num(b.cost); if(c != null && !isFinite(c)) return sendJSON(res,400,{error:'cost must be a number'}); wo.cost = c; }
    wo.updated_by = user; wo.updated_ts = new Date().toISOString();
    const ok = saveStore('workorders', rows);
    return sendJSON(res, ok?200:500, ok ? { ok:true, entry:wo } : { error:'could not save' });
  }
  if(url === '/api/workorders/delete' && method === 'POST'){
    const { id } = await readBody(req);
    const rows = loadStore('workorders').filter(r => r.id !== id);
    const ok = saveStore('workorders', rows);
    return sendJSON(res, ok?200:500, ok ? { ok:true } : { error:'could not save' });
  }

  // ---- pages & static ----
  if(PAGES[url]) return sendFile(res, PAGES[url]);
  const name = url.replace(/^\/+/, '');
  if(STATIC_WHITELIST.has(name)) return sendFile(res, name);

  res.writeHead(302, { 'Location':'/owner' });
  res.end();
}).listen(PORT, () => console.log('cph-owner-app on :' + PORT + ' (store dir: ' + BASE_DIR + ')'));
