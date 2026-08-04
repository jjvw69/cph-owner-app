'use strict';
/**
 * cph-owner-app — standalone server for the Caribbean Paradise Homes
 * Owner App + Property-Management Console + operational tools.
 * Completely separate from cph-my-stay (guest app + concierge console).
 *
 * Staff login (ivonna, jan, maria) via env-var codes. Persistent JSON on a
 * disk (DATA_DIR, default /var/data). Stores: properties, owners, readings,
 * workorders. Manage area (properties + owners) is admin-only (ADMIN_USERS,
 * default "jan"). Owners each get a code to log into the owner app.
 */
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const BUILD = String(Date.now()); // changes on every deploy/restart → clients can detect updates

// ---- staff users & auth -------------------------------------------------
const USERS = {
  ivonna: process.env.CODE_IVONNA || 'ivonna-demo',
  jan:    process.env.CODE_JAN    || 'jan-demo',
  maria:  process.env.CODE_MARIA  || 'maria-demo'
};
const ADMIN_USERS = (process.env.ADMIN_USERS || 'jan').split(',').map(s => s.trim().toLowerCase());
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
function isAdmin(user){ return !!user && ADMIN_USERS.indexOf(user) >= 0; }

// ---- generic JSON store (persistent disk if available) ------------------
const DATA_DIR = process.env.DATA_DIR || '/var/data';
let BASE_DIR = DATA_DIR;
try { fs.mkdirSync(DATA_DIR, { recursive: true }); }
catch(e) { BASE_DIR = __dirname; }
const PHOTO_DIR = path.join(BASE_DIR, 'photos');
try { fs.mkdirSync(PHOTO_DIR, { recursive: true }); } catch(e){}
function storePath(name){ return path.join(BASE_DIR, name + '.json'); }
function loadStore(name){ try { return JSON.parse(fs.readFileSync(storePath(name), 'utf8')); } catch(e){ return null; } }
function saveStore(name, arr){ try { fs.writeFileSync(storePath(name), JSON.stringify(arr, null, 2)); return true; } catch(e){ return false; } }
function newId(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,6); }

// Properties (villas) — seed with the original six on first run.
const DEFAULT_PROPERTIES = [
  { name:'Villa Cajuiles 12',     meta:'6 bed · pool · staffed' },
  { name:'Villa Vistamar 8',      meta:'5 bed · oceanfront' },
  { name:'Villa Barranca Este 24',meta:'7 bed · pool · gym' },
  { name:'Villa Las Colinas 31',  meta:'4 bed · garden' },
  { name:'Villa Punta Aguila 5',  meta:'6 bed · beachfront' },
  { name:'Villa Los Naranjos 78', meta:'4 bed · golf' }
];
function loadProperties(){
  let p = loadStore('properties');
  if(!p){ p = DEFAULT_PROPERTIES.map(x => ({ id:newId(), name:x.name, meta:x.meta, active:true })); saveStore('properties', p); }
  return p;
}
function villaNames(){ return loadProperties().filter(p => p.active !== false).map(p => p.name); }
function loadOwners(){ return loadStore('owners') || []; }
const WO_STATUSES = ['Open','Quoting','Approved','Parts ordered','Scheduled','Done'];
const INV_STATUSES = ['Unpaid','Approved','Paid','Disputed'];
const INV_CHARGED  = ['Owner','Absorbed','Rental'];
const QUOTE_STATUSES = ['Pending','Approved','Rejected'];
const STAFF_ROLES = ['Housekeeper','Gardener','Pool','Maintenance','Caretaker','Security','Other'];

// ---- helpers ------------------------------------------------------------
const TYPES = {
  '.html':'text/html; charset=utf-8', '.js':'application/javascript; charset=utf-8',
  '.jsx':'application/javascript; charset=utf-8', '.css':'text/css; charset=utf-8',
  '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp',
  '.svg':'image/svg+xml', '.ico':'image/x-icon'
};
const PAGES = {
  '/':'owner.html', '/owner':'owner.html',
  '/console':'console.html',
  '/property-console':'property-console.html',
  '/owner-design':'owner-design.html'
};
// Old standalone tools now live as sections inside /console.
const REDIRECTS = { '/readings':'/console', '/work-orders':'/console', '/manage':'/console' };
const STATIC_WHITELIST = new Set(['support.js','doc-page.js','ios-frame.jsx','cph-logo.png']);

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
    let b=''; req.on('data', c => { b+=c; if(b.length>5e6) req.destroy(); });
    req.on('end', () => { try{ resolve(JSON.parse(b||'{}')); }catch(e){ resolve({}); } });
  });
}
function num(v){ return (v === '' || v == null) ? null : Number(v); }
function str(v, n){ return String(v==null?'':v).slice(0, n||200); }

// ---- server -------------------------------------------------------------
http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];
  const method = req.method;

  if(url === '/healthz'){ res.writeHead(200,{'Content-Type':'text/plain'}); return res.end('ok'); }
  if(url === '/api/version'){ return sendJSON(res, 200, { v: BUILD }); }

  // ---- staff auth ----
  if(url === '/api/login' && method === 'POST'){
    const { name, code } = await readBody(req);
    const u = String(name||'').toLowerCase().trim();
    if(USERS[u] && code && String(code) === USERS[u]){
      const tok = makeToken(u);
      return sendJSON(res, 200, { ok:true, user:u, isAdmin:isAdmin(u) }, {
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
    return u ? sendJSON(res, 200, { user:u, villas:villaNames(), wo_statuses:WO_STATUSES, isAdmin:isAdmin(u) })
             : sendJSON(res, 401, { error:'not signed in' });
  }

  // ---- owner-app login (owners store; public) ----
  if(url === '/api/owner/login' && method === 'POST'){
    const b = await readBody(req);
    const code = String(b.code||'').trim().toUpperCase();
    const last = String(b.lastName||'').trim().toLowerCase();
    if(!code) return sendJSON(res, 400, { error:'code required' });
    const owner = loadOwners().filter(o => o.active !== false)
      .find(o => String(o.code||'').trim().toUpperCase() === code
        && (!last || String(o.lastName||o.name||'').toLowerCase().indexOf(last) >= 0));
    if(!owner) return sendJSON(res, 401, { error:'not found' });
    return sendJSON(res, 200, { ok:true, owner:{ name:owner.name, villa:owner.villa, lang:owner.lang || 'es' } });
  }

  // ---- staff-only below ----
  const isApi = url.indexOf('/api/') === 0;
  const user = currentUser(req);
  if(isApi && !user) return sendJSON(res, 401, { error:'not signed in' });
  const admin = isAdmin(user);
  const needAdmin = () => { sendJSON(res, 403, { error:'admin only' }); return true; };

  // ---- photo serving (auth) ----
  if(url.indexOf('/api/photo/') === 0 && method === 'GET'){
    const pid = url.slice('/api/photo/'.length).replace(/[^a-z0-9]/gi,'');
    return fs.readFile(path.join(PHOTO_DIR, pid + '.jpg'), (e,buf)=>{
      if(e){ res.writeHead(404); return res.end('no'); }
      res.writeHead(200, {'Content-Type':'image/jpeg','Cache-Control':'private, max-age=86400'}); res.end(buf);
    });
  }
  if(url === '/api/workorders/photo' && method === 'POST'){
    const b = await readBody(req);
    const rows = loadStore('workorders')||[]; const wo = rows.find(x=>x.id===b.id);
    if(!wo) return sendJSON(res, 404, { error:'not found' });
    const m = /^data:image\/[a-z+]+;base64,(.+)$/i.exec(String(b.data||''));
    if(!m) return sendJSON(res, 400, { error:'invalid image' });
    const buf = Buffer.from(m[1], 'base64');
    if(buf.length > 4*1024*1024) return sendJSON(res, 400, { error:'image too large' });
    const pid = newId();
    try { fs.writeFileSync(path.join(PHOTO_DIR, pid + '.jpg'), buf); } catch(e){ return sendJSON(res, 500, { error:'could not save image' }); }
    const photo = { id:pid, by:user, ts:new Date().toISOString() };
    wo.photos = wo.photos || []; wo.photos.push(photo);
    wo.updated_by = user; wo.updated_ts = new Date().toISOString();
    return sendJSON(res, saveStore('workorders',rows)?200:500, { ok:true, photo });
  }
  if(url === '/api/workorders/photo/delete' && method === 'POST'){
    const b = await readBody(req);
    const rows = loadStore('workorders')||[]; const wo = rows.find(x=>x.id===b.id);
    if(!wo) return sendJSON(res, 404, { error:'not found' });
    wo.photos = (wo.photos||[]).filter(p=>p.id!==b.photoId);
    try { fs.unlinkSync(path.join(PHOTO_DIR, String(b.photoId||'').replace(/[^a-z0-9]/gi,'') + '.jpg')); } catch(e){}
    return sendJSON(res, saveStore('workorders',rows)?200:500, { ok:true });
  }
  // ---- property photos (any signed-in staff) ----
  if(url === '/api/properties/photo' && method === 'POST'){
    const b = await readBody(req);
    const rows = loadProperties(); const p = rows.find(x=>x.id===b.id);
    if(!p) return sendJSON(res, 404, { error:'not found' });
    const m = /^data:image\/[a-z+]+;base64,(.+)$/i.exec(String(b.data||''));
    if(!m) return sendJSON(res, 400, { error:'invalid image' });
    const buf = Buffer.from(m[1], 'base64');
    if(buf.length > 4*1024*1024) return sendJSON(res, 400, { error:'image too large' });
    const pid = newId();
    try { fs.writeFileSync(path.join(PHOTO_DIR, pid + '.jpg'), buf); } catch(e){ return sendJSON(res, 500, { error:'could not save image' }); }
    const photo = { id:pid, by:user, ts:new Date().toISOString() };
    p.photos = p.photos || []; p.photos.push(photo);
    return sendJSON(res, saveStore('properties',rows)?200:500, { ok:true, photo });
  }
  if(url === '/api/properties/photo/delete' && method === 'POST'){
    const b = await readBody(req);
    const rows = loadProperties(); const p = rows.find(x=>x.id===b.id);
    if(!p) return sendJSON(res, 404, { error:'not found' });
    p.photos = (p.photos||[]).filter(ph=>ph.id!==b.photoId);
    try { fs.unlinkSync(path.join(PHOTO_DIR, String(b.photoId||'').replace(/[^a-z0-9]/gi,'') + '.jpg')); } catch(e){}
    return sendJSON(res, saveStore('properties',rows)?200:500, { ok:true });
  }

  // ---- meter readings ----
  if(url === '/api/readings' && method === 'GET'){ return sendJSON(res, 200, { readings: loadStore('readings')||[] }); }
  if(url === '/api/readings' && method === 'POST'){
    const b = await readBody(req);
    const villa = String(b.villa||'').trim();
    if(villaNames().indexOf(villa) < 0) return sendJSON(res, 400, { error:'unknown villa' });
    const elec = num(b.electricity_kwh), water = num(b.water_gal);
    if(elec == null && water == null) return sendJSON(res, 400, { error:'enter at least one reading' });
    if((elec != null && !isFinite(elec)) || (water != null && !isFinite(water))) return sendJSON(res, 400, { error:'readings must be numbers' });
    const rows = loadStore('readings')||[];
    const entry = { id:newId(), villa, electricity_kwh:elec, water_gal:water, note:str(b.note,300), user, ts:new Date().toISOString() };
    rows.unshift(entry);
    return sendJSON(res, saveStore('readings',rows)?200:500, { ok:true, entry });
  }
  if(url === '/api/readings/delete' && method === 'POST'){
    const { id } = await readBody(req);
    return sendJSON(res, saveStore('readings',(loadStore('readings')||[]).filter(r=>r.id!==id))?200:500, { ok:true });
  }

  // ---- work orders ----
  if(url === '/api/workorders' && method === 'GET'){ return sendJSON(res, 200, { workorders: loadStore('workorders')||[], statuses: WO_STATUSES }); }
  if(url === '/api/workorders' && method === 'POST'){
    const b = await readBody(req);
    const villa = String(b.villa||'').trim();
    const title = String(b.title||'').trim();
    if(villaNames().indexOf(villa) < 0) return sendJSON(res, 400, { error:'unknown villa' });
    if(!title) return sendJSON(res, 400, { error:'title required' });
    const cost = num(b.cost);
    if(cost != null && !isFinite(cost)) return sendJSON(res, 400, { error:'cost must be a number' });
    const status = WO_STATUSES.indexOf(b.status) >= 0 ? b.status : 'Open';
    const rows = loadStore('workorders')||[];
    const entry = { id:newId(), villa, title, vendor:str(b.vendor,120), cost, status, note:str(b.note,400),
      why:str(b.why,800), scheduled_date:str(b.scheduled_date,20), recurring:str(b.recurring,20), time_estimate:str(b.time_estimate,40),
      created_by:user, created_ts:new Date().toISOString(), updated_by:user, updated_ts:new Date().toISOString() };
    rows.unshift(entry);
    return sendJSON(res, saveStore('workorders',rows)?200:500, { ok:true, entry });
  }
  if(url === '/api/workorders/update' && method === 'POST'){
    const b = await readBody(req);
    const rows = loadStore('workorders')||[];
    const wo = rows.find(x => x.id === b.id);
    if(!wo) return sendJSON(res, 404, { error:'not found' });
    if(b.status != null){ if(WO_STATUSES.indexOf(b.status) < 0) return sendJSON(res,400,{error:'unknown status'}); wo.status = b.status; }
    if(b.note != null) wo.note = str(b.note,400);
    if(b.why != null) wo.why = str(b.why,800);
    if(b.scheduled_date != null) wo.scheduled_date = str(b.scheduled_date,20);
    if(b.recurring != null) wo.recurring = str(b.recurring,20);
    if(b.time_estimate != null) wo.time_estimate = str(b.time_estimate,40);
    if(b.vendor != null) wo.vendor = str(b.vendor,120);
    if(b.title != null && String(b.title).trim()) wo.title = String(b.title).trim();
    if(b.villa != null && villaNames().indexOf(String(b.villa).trim()) >= 0) wo.villa = String(b.villa).trim();
    if(b.cost !== undefined){ const c=num(b.cost); if(c!=null && !isFinite(c)) return sendJSON(res,400,{error:'cost must be a number'}); wo.cost=c; }
    wo.updated_by = user; wo.updated_ts = new Date().toISOString();
    return sendJSON(res, saveStore('workorders',rows)?200:500, { ok:true, entry:wo });
  }
  if(url === '/api/workorders/delete' && method === 'POST'){
    const { id } = await readBody(req);
    return sendJSON(res, saveStore('workorders',(loadStore('workorders')||[]).filter(r=>r.id!==id))?200:500, { ok:true });
  }

  // ---- staff (labour) ----
  if(url === '/api/staff' && method === 'GET'){ return sendJSON(res, 200, { staff: loadStore('staff')||[], roles: STAFF_ROLES }); }
  if(url === '/api/staff' && method === 'POST'){
    const b = await readBody(req);
    const name = String(b.name||'').trim();
    if(!name) return sendJSON(res, 400, { error:'name required' });
    const rate = num(b.rate);
    if(rate != null && !isFinite(rate)) return sendJSON(res, 400, { error:'rate must be a number' });
    const rows = loadStore('staff')||[];
    const entry = { id:newId(), name, role:(STAFF_ROLES.indexOf(b.role)>=0?b.role:'Other'),
      villa:str(b.villa,120), rate, active:true, created_by:user, created_ts:new Date().toISOString() };
    rows.push(entry);
    return sendJSON(res, saveStore('staff',rows)?200:500, { ok:true, entry });
  }
  if(url === '/api/staff/update' && method === 'POST'){
    const b = await readBody(req);
    const rows = loadStore('staff')||[]; const s = rows.find(x=>x.id===b.id);
    if(!s) return sendJSON(res, 404, { error:'not found' });
    if(b.name != null && String(b.name).trim()) s.name = String(b.name).trim();
    if(b.role != null && STAFF_ROLES.indexOf(b.role)>=0) s.role = b.role;
    if(b.villa != null) s.villa = str(b.villa,120);
    if(b.rate !== undefined){ const r=num(b.rate); if(r!=null && !isFinite(r)) return sendJSON(res,400,{error:'rate must be a number'}); s.rate=r; }
    if(b.active != null) s.active = !!b.active;
    return sendJSON(res, saveStore('staff',rows)?200:500, { ok:true, entry:s });
  }
  if(url === '/api/staff/delete' && method === 'POST'){
    const { id } = await readBody(req);
    return sendJSON(res, saveStore('staff',(loadStore('staff')||[]).filter(s=>s.id!==id))?200:500, { ok:true });
  }

  // ---- hours worked ----
  if(url === '/api/hours' && method === 'GET'){ return sendJSON(res, 200, { hours: loadStore('hours')||[] }); }
  if(url === '/api/hours' && method === 'POST'){
    const b = await readBody(req);
    const staffId = String(b.staff_id||'').trim();
    const staff = (loadStore('staff')||[]).find(s=>s.id===staffId);
    if(!staff) return sendJSON(res, 400, { error:'choose a staff member' });
    const hours = num(b.hours);
    if(hours == null || !isFinite(hours) || hours <= 0) return sendJSON(res, 400, { error:'hours must be a positive number' });
    const villa = String(b.villa||'').trim();
    if(villa && villa !== 'All villas' && villaNames().indexOf(villa) < 0) return sendJSON(res, 400, { error:'unknown villa' });
    const rows = loadStore('hours')||[];
    const entry = { id:newId(), staff_id:staffId, staff_name:staff.name, villa, hours,
      date:str(b.date,20) || new Date().toISOString().slice(0,10), note:str(b.note,240),
      cost: (staff.rate!=null ? Math.round(staff.rate*hours*100)/100 : null),
      user, ts:new Date().toISOString() };
    rows.unshift(entry);
    return sendJSON(res, saveStore('hours',rows)?200:500, { ok:true, entry });
  }
  if(url === '/api/hours/delete' && method === 'POST'){
    const { id } = await readBody(req);
    return sendJSON(res, saveStore('hours',(loadStore('hours')||[]).filter(h=>h.id!==id))?200:500, { ok:true });
  }

  // ---- quotes ----
  if(url === '/api/quotes' && method === 'GET'){ return sendJSON(res, 200, { quotes: loadStore('quotes')||[], statuses: QUOTE_STATUSES }); }
  if(url === '/api/quotes' && method === 'POST'){
    const b = await readBody(req);
    const title = String(b.title||'').trim();
    const vendor = String(b.vendor||'').trim();
    if(!title) return sendJSON(res, 400, { error:'what is the job?' });
    if(!vendor) return sendJSON(res, 400, { error:'vendor required' });
    const amount = num(b.amount);
    if(amount == null || !isFinite(amount)) return sendJSON(res, 400, { error:'amount must be a number' });
    const villa = String(b.villa||'').trim();
    if(villa && villa !== 'All villas' && villaNames().indexOf(villa) < 0) return sendJSON(res, 400, { error:'unknown villa' });
    const rows = loadStore('quotes')||[];
    const entry = { id:newId(), title, vendor, villa, amount,
      status: QUOTE_STATUSES.indexOf(b.status)>=0 ? b.status : 'Pending',
      lead_time:str(b.lead_time,60), note:str(b.note,400),
      created_by:user, created_ts:new Date().toISOString(), updated_by:user, updated_ts:new Date().toISOString() };
    rows.unshift(entry);
    return sendJSON(res, saveStore('quotes',rows)?200:500, { ok:true, entry });
  }
  if(url === '/api/quotes/update' && method === 'POST'){
    const b = await readBody(req);
    const rows = loadStore('quotes')||[]; const q = rows.find(x=>x.id===b.id);
    if(!q) return sendJSON(res, 404, { error:'not found' });
    if(b.status != null){ if(QUOTE_STATUSES.indexOf(b.status)<0) return sendJSON(res,400,{error:'unknown status'}); q.status = b.status; }
    if(b.title != null && String(b.title).trim()) q.title = String(b.title).trim();
    if(b.vendor != null && String(b.vendor).trim()) q.vendor = String(b.vendor).trim();
    if(b.villa != null) q.villa = str(b.villa,120);
    if(b.amount !== undefined){ const a=num(b.amount); if(a!=null && !isFinite(a)) return sendJSON(res,400,{error:'amount must be a number'}); q.amount=a; }
    if(b.lead_time != null) q.lead_time = str(b.lead_time,60);
    if(b.note != null) q.note = str(b.note,400);
    q.updated_by = user; q.updated_ts = new Date().toISOString();
    return sendJSON(res, saveStore('quotes',rows)?200:500, { ok:true, entry:q });
  }
  if(url === '/api/quotes/delete' && method === 'POST'){
    const { id } = await readBody(req);
    return sendJSON(res, saveStore('quotes',(loadStore('quotes')||[]).filter(q=>q.id!==id))?200:500, { ok:true });
  }

  // ---- owner statement (computed, never stored) ----
  if(url.indexOf('/api/statement') === 0 && method === 'GET'){
    const qs = new URLSearchParams((req.url.split('?')[1])||'');
    const villa = qs.get('villa')||'';
    const month = qs.get('month')||new Date().toISOString().slice(0,7); // YYYY-MM
    if(!villa) return sendJSON(res, 400, { error:'villa required' });
    const inMonth = (d) => String(d||'').slice(0,7) === month;
    const invoices = (loadStore('invoices')||[]).filter(i =>
      (i.villa === villa || i.villa === 'All villas') && inMonth(i.date || i.created_ts));
    const readings = (loadStore('readings')||[]).filter(r => r.villa === villa && inMonth(r.ts));
    const hours    = (loadStore('hours')||[]).filter(h => h.villa === villa && inMonth(h.date));
    const workorders = (loadStore('workorders')||[]).filter(w => w.villa === villa && inMonth(w.created_ts));
    const sum = (arr,f) => Math.round(arr.reduce((a,x)=>a+(Number(f(x))||0),0)*100)/100;
    return sendJSON(res, 200, { villa, month,
      invoices, readings, hours, workorders,
      totals: {
        owner_billable: sum(invoices.filter(i=>(i.charged||'Owner')==='Owner'), i=>i.amount),
        absorbed:       sum(invoices.filter(i=>i.charged==='Absorbed'), i=>i.amount),
        invoices_total: sum(invoices, i=>i.amount),
        labour_cost:    sum(hours, h=>h.cost),
        labour_hours:   sum(hours, h=>h.hours),
        electricity_kwh: sum(readings, r=>r.electricity_kwh),
        water_gal:       sum(readings, r=>r.water_gal),
        open_workorders: workorders.filter(w=>w.status!=='Done').length
      }
    });
  }

  // ---- backup / restore (admin) ----
  if(url === '/api/backup' && method === 'GET'){
    if(!admin) return needAdmin();
    const dump = {
      exported_at: new Date().toISOString(), exported_by: user, version: 1,
      properties: loadProperties(), owners: loadOwners(),
      readings: loadStore('readings')||[], workorders: loadStore('workorders')||[],
      invoices: loadStore('invoices')||[], staff: loadStore('staff')||[],
      hours: loadStore('hours')||[], quotes: loadStore('quotes')||[]
    };
    res.writeHead(200, {
      'Content-Type':'application/json; charset=utf-8',
      'Content-Disposition':'attachment; filename="cph-console-backup-'+new Date().toISOString().slice(0,10)+'.json"'
    });
    return res.end(JSON.stringify(dump, null, 2));
  }
  if(url === '/api/restore' && method === 'POST'){
    if(!admin) return needAdmin();
    const b = await readBody(req);
    const KEYS = ['properties','owners','readings','workorders','invoices','staff','hours','quotes'];
    const restored = [];
    for(const k of KEYS){
      if(Array.isArray(b[k])){ if(saveStore(k, b[k])) restored.push(k+':'+b[k].length); }
    }
    if(!restored.length) return sendJSON(res, 400, { error:'nothing to restore — is this a console backup file?' });
    return sendJSON(res, 200, { ok:true, restored });
  }

  // ---- invoices (any signed-in staff) ----
  if(url === '/api/invoices' && method === 'GET'){
    return sendJSON(res, 200, { invoices: loadStore('invoices')||[], statuses: INV_STATUSES, charged: INV_CHARGED });
  }
  if(url === '/api/invoices' && method === 'POST'){
    const b = await readBody(req);
    const vendor = String(b.vendor||'').trim();
    if(!vendor) return sendJSON(res, 400, { error:'vendor required' });
    const amount = num(b.amount);
    if(amount == null || !isFinite(amount)) return sendJSON(res, 400, { error:'amount must be a number' });
    const villa = String(b.villa||'').trim();
    if(villa && villa !== 'All villas' && villaNames().indexOf(villa) < 0) return sendJSON(res, 400, { error:'unknown villa' });
    const status  = INV_STATUSES.indexOf(b.status)  >= 0 ? b.status  : 'Unpaid';
    const charged = INV_CHARGED.indexOf(b.charged)  >= 0 ? b.charged : 'Owner';
    const rows = loadStore('invoices')||[];
    const entry = { id:newId(), vendor, villa, amount, status, charged,
      number:str(b.number,60), description:str(b.description,300),
      date:str(b.date,20), due_date:str(b.due_date,20), photos:[],
      created_by:user, created_ts:new Date().toISOString(), updated_by:user, updated_ts:new Date().toISOString() };
    rows.unshift(entry);
    return sendJSON(res, saveStore('invoices',rows)?200:500, { ok:true, entry });
  }
  if(url === '/api/invoices/update' && method === 'POST'){
    const b = await readBody(req);
    const rows = loadStore('invoices')||[]; const inv = rows.find(x=>x.id===b.id);
    if(!inv) return sendJSON(res, 404, { error:'not found' });
    if(b.status  != null){ if(INV_STATUSES.indexOf(b.status) < 0) return sendJSON(res,400,{error:'unknown status'}); inv.status = b.status; }
    if(b.charged != null){ if(INV_CHARGED.indexOf(b.charged) < 0) return sendJSON(res,400,{error:'unknown charge type'}); inv.charged = b.charged; }
    if(b.vendor != null && String(b.vendor).trim()) inv.vendor = String(b.vendor).trim();
    if(b.villa != null){ const v=String(b.villa).trim(); if(v && v!=='All villas' && villaNames().indexOf(v)<0) return sendJSON(res,400,{error:'unknown villa'}); inv.villa = v; }
    if(b.amount !== undefined){ const a=num(b.amount); if(a!=null && !isFinite(a)) return sendJSON(res,400,{error:'amount must be a number'}); inv.amount=a; }
    if(b.number != null) inv.number = str(b.number,60);
    if(b.description != null) inv.description = str(b.description,300);
    if(b.date != null) inv.date = str(b.date,20);
    if(b.due_date != null) inv.due_date = str(b.due_date,20);
    inv.updated_by = user; inv.updated_ts = new Date().toISOString();
    return sendJSON(res, saveStore('invoices',rows)?200:500, { ok:true, entry:inv });
  }
  if(url === '/api/invoices/delete' && method === 'POST'){
    const { id } = await readBody(req);
    return sendJSON(res, saveStore('invoices',(loadStore('invoices')||[]).filter(r=>r.id!==id))?200:500, { ok:true });
  }
  if(url === '/api/invoices/photo' && method === 'POST'){
    const b = await readBody(req);
    const rows = loadStore('invoices')||[]; const inv = rows.find(x=>x.id===b.id);
    if(!inv) return sendJSON(res, 404, { error:'not found' });
    const m = /^data:image\/[a-z+]+;base64,(.+)$/i.exec(String(b.data||''));
    if(!m) return sendJSON(res, 400, { error:'invalid image' });
    const buf = Buffer.from(m[1], 'base64');
    if(buf.length > 4*1024*1024) return sendJSON(res, 400, { error:'image too large' });
    const pid = newId();
    try { fs.writeFileSync(path.join(PHOTO_DIR, pid + '.jpg'), buf); } catch(e){ return sendJSON(res, 500, { error:'could not save image' }); }
    const photo = { id:pid, by:user, ts:new Date().toISOString() };
    inv.photos = inv.photos || []; inv.photos.push(photo);
    inv.updated_by = user; inv.updated_ts = new Date().toISOString();
    return sendJSON(res, saveStore('invoices',rows)?200:500, { ok:true, photo });
  }
  if(url === '/api/invoices/photo/delete' && method === 'POST'){
    const b = await readBody(req);
    const rows = loadStore('invoices')||[]; const inv = rows.find(x=>x.id===b.id);
    if(!inv) return sendJSON(res, 404, { error:'not found' });
    inv.photos = (inv.photos||[]).filter(p=>p.id!==b.photoId);
    try { fs.unlinkSync(path.join(PHOTO_DIR, String(b.photoId||'').replace(/[^a-z0-9]/gi,'') + '.jpg')); } catch(e){}
    return sendJSON(res, saveStore('invoices',rows)?200:500, { ok:true });
  }

  // ---- properties (admin) ----
  if(url === '/api/properties' && method === 'GET'){ return sendJSON(res, 200, { properties: loadProperties() }); }
  if(url === '/api/properties' && method === 'POST'){
    if(!admin) return needAdmin();
    const b = await readBody(req);
    const name = String(b.name||'').trim();
    if(!name) return sendJSON(res, 400, { error:'villa name required' });
    const rows = loadProperties();
    if(rows.some(p => p.name.toLowerCase() === name.toLowerCase())) return sendJSON(res, 400, { error:'villa already exists' });
    const entry = { id:newId(), name, meta:str(b.meta,120), area:str(b.area,120), active:true };
    rows.push(entry);
    return sendJSON(res, saveStore('properties',rows)?200:500, { ok:true, entry });
  }
  if(url === '/api/properties/update' && method === 'POST'){
    if(!admin) return needAdmin();
    const b = await readBody(req);
    const rows = loadProperties(); const p = rows.find(x=>x.id===b.id);
    if(!p) return sendJSON(res, 404, { error:'not found' });
    if(b.name != null && String(b.name).trim()) p.name = String(b.name).trim();
    if(b.meta != null) p.meta = str(b.meta,120);
    if(b.area != null) p.area = str(b.area,120);
    if(b.active != null) p.active = !!b.active;
    return sendJSON(res, saveStore('properties',rows)?200:500, { ok:true, entry:p });
  }
  if(url === '/api/properties/delete' && method === 'POST'){
    if(!admin) return needAdmin();
    const { id } = await readBody(req);
    return sendJSON(res, saveStore('properties',loadProperties().filter(p=>p.id!==id))?200:500, { ok:true });
  }

  // ---- owners (admin) ----
  if(url === '/api/owners' && method === 'GET'){ if(!admin) return needAdmin(); return sendJSON(res, 200, { owners: loadOwners(), villas: villaNames() }); }
  if(url === '/api/owners' && method === 'POST'){
    if(!admin) return needAdmin();
    const b = await readBody(req);
    const name = String(b.name||'').trim();
    const code = String(b.code||'').trim();
    if(!name) return sendJSON(res, 400, { error:'owner name required' });
    if(!code) return sendJSON(res, 400, { error:'login code required' });
    const owners = loadOwners();
    if(owners.some(o => String(o.code||'').toUpperCase() === code.toUpperCase())) return sendJSON(res, 400, { error:'code already in use' });
    const entry = { id:newId(), name, email:str(b.email,160), villa:str(b.villa,120), code, lang:(b.lang==='en'?'en':'es'),
      lastName:str(b.lastName,80), active:true, created_by:user, created_ts:new Date().toISOString() };
    owners.push(entry);
    return sendJSON(res, saveStore('owners',owners)?200:500, { ok:true, entry });
  }
  if(url === '/api/owners/update' && method === 'POST'){
    if(!admin) return needAdmin();
    const b = await readBody(req);
    const owners = loadOwners(); const o = owners.find(x=>x.id===b.id);
    if(!o) return sendJSON(res, 404, { error:'not found' });
    if(b.name != null && String(b.name).trim()) o.name = String(b.name).trim();
    if(b.email != null) o.email = str(b.email,160);
    if(b.villa != null) o.villa = str(b.villa,120);
    if(b.lastName != null) o.lastName = str(b.lastName,80);
    if(b.lang != null) o.lang = (b.lang==='en'?'en':'es');
    if(b.code != null && String(b.code).trim()){
      const code = String(b.code).trim();
      if(owners.some(x => x.id!==o.id && String(x.code||'').toUpperCase()===code.toUpperCase())) return sendJSON(res,400,{error:'code already in use'});
      o.code = code;
    }
    if(b.active != null) o.active = !!b.active;
    return sendJSON(res, saveStore('owners',owners)?200:500, { ok:true, entry:o });
  }
  if(url === '/api/owners/delete' && method === 'POST'){
    if(!admin) return needAdmin();
    const { id } = await readBody(req);
    return sendJSON(res, saveStore('owners',loadOwners().filter(o=>o.id!==id))?200:500, { ok:true });
  }

  // ---- pages & static ----
  if(REDIRECTS[url]){ res.writeHead(302, { 'Location': REDIRECTS[url] }); return res.end(); }
  if(PAGES[url]) return sendFile(res, PAGES[url]);
  const name = url.replace(/^\/+/, '');
  if(STATIC_WHITELIST.has(name)) return sendFile(res, name);

  res.writeHead(302, { 'Location':'/owner' });
  res.end();
}).listen(PORT, () => console.log('cph-owner-app on :' + PORT + ' (store dir: ' + BASE_DIR + ')'));
