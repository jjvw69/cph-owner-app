'use strict';
/**
 * cph-owner-app — standalone server for the Caribbean Paradise Homes
 * Owner App + Property-Management Console. Completely separate from
 * cph-my-stay (guest app + concierge console).
 *
 * Adds a real, persistent Meter-Readings feature behind a 3-user login
 * (ivonna, jan, maria). Access codes come from environment variables
 * (never committed). Data is stored as JSON on a persistent disk when one
 * is mounted (DATA_DIR, default /var/data), falling back to ./ if not.
 */
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;

// ---- users & auth -------------------------------------------------------
// Codes are read from env vars so they never live in the public repo.
// Fallback demo codes are used only if the env vars are unset.
const USERS = {
  ivonna: process.env.CODE_IVONNA || 'ivonna-demo',
  jan:    process.env.CODE_JAN    || 'jan-demo',
  maria:  process.env.CODE_MARIA  || 'maria-demo'
};
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
const COOKIE = 'cph_owner_sess';

function sign(v){ return crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('base64url'); }
function makeToken(user){
  const body = user + '.' + Date.now();
  return body + '.' + sign(body);
}
function verifyToken(tok){
  if(!tok) return null;
  const parts = String(tok).split('.');
  if(parts.length !== 3) return null;
  const [user, ts, mac] = parts;
  if(sign(user + '.' + ts) !== mac) return null;
  if(!USERS[user]) return null;
  if(Date.now() - Number(ts) > 30*24*3600*1000) return null; // 30-day expiry
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

// ---- data store (persistent disk if available) --------------------------
const DATA_DIR = process.env.DATA_DIR || '/var/data';
let STORE_FILE = path.join(DATA_DIR, 'readings.json');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); }
catch(e) { STORE_FILE = path.join(__dirname, 'readings.json'); } // fallback: ephemeral
function loadReadings(){
  try { return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); }
  catch(e){ return []; }
}
function saveReadings(arr){
  try { fs.writeFileSync(STORE_FILE, JSON.stringify(arr, null, 2)); return true; }
  catch(e){ return false; }
}

const VILLAS = [
  'Villa Cajuiles 12','Villa Vistamar 8','Villa Barranca Este 24',
  'Villa Las Colinas 31','Villa Punta Aguila 5','Villa Los Naranjos 78'
];

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
  '/readings':'readings.html'
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

// ---- server -------------------------------------------------------------
http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];

  if(url === '/healthz'){ res.writeHead(200,{'Content-Type':'text/plain'}); return res.end('ok'); }

  // ---- API ----
  if(url === '/api/login' && req.method === 'POST'){
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
  if(url === '/api/logout' && req.method === 'POST'){
    return sendJSON(res, 200, { ok:true }, { 'Set-Cookie': COOKIE+'=; Path=/; HttpOnly; Max-Age=0' });
  }
  if(url === '/api/me'){
    const u = currentUser(req);
    return u ? sendJSON(res, 200, { user:u, villas:VILLAS }) : sendJSON(res, 401, { error:'not signed in' });
  }
  if(url === '/api/readings' && req.method === 'GET'){
    if(!currentUser(req)) return sendJSON(res, 401, { error:'not signed in' });
    return sendJSON(res, 200, { readings: loadReadings() });
  }
  if(url === '/api/readings' && req.method === 'POST'){
    const u = currentUser(req);
    if(!u) return sendJSON(res, 401, { error:'not signed in' });
    const b = await readBody(req);
    const villa = String(b.villa||'').trim();
    if(VILLAS.indexOf(villa) < 0) return sendJSON(res, 400, { error:'unknown villa' });
    const elec  = (b.electricity_kwh === '' || b.electricity_kwh == null) ? null : Number(b.electricity_kwh);
    const water = (b.water_gal === '' || b.water_gal == null) ? null : Number(b.water_gal);
    if(elec == null && water == null) return sendJSON(res, 400, { error:'enter at least one reading' });
    if((elec != null && !isFinite(elec)) || (water != null && !isFinite(water)))
      return sendJSON(res, 400, { error:'readings must be numbers' });
    const rows = loadReadings();
    const entry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
      villa, electricity_kwh: elec, water_gal: water,
      note: String(b.note||'').slice(0,300),
      user: u, ts: new Date().toISOString()
    };
    rows.unshift(entry);
    const ok = saveReadings(rows);
    return sendJSON(res, ok?200:500, ok ? { ok:true, entry } : { error:'could not save' });
  }

  // ---- pages ----
  if(PAGES[url]) return sendFile(res, PAGES[url]);
  const name = url.replace(/^\/+/, '');
  if(STATIC_WHITELIST.has(name)) return sendFile(res, name);

  res.writeHead(302, { 'Location':'/owner' });
  res.end();
}).listen(PORT, () => console.log('cph-owner-app on :' + PORT + ' (store: ' + STORE_FILE + ')'));
