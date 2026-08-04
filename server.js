'use strict';
// cph-owner-app — standalone static server for the Owner App + Property Console.
// Completely separate from cph-my-stay (guest app + concierge console).
const http = require('http');
const fs   = require('fs');
const path = require('path');
const PORT = process.env.PORT || 3000;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js'  : 'application/javascript; charset=utf-8',
  '.css' : 'text/css; charset=utf-8',
  '.png' : 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

// page routes
const PAGES = {
  '/'                 : 'owner.html',
  '/owner'            : 'owner.html',
  '/property-console' : 'property-console.html'
};

// files that may be requested directly (the console pulls ./support.js, ./doc-page.js)
const STATIC_WHITELIST = new Set(['support.js', 'doc-page.js']);

function send(res, file) {
  const p = path.join(__dirname, file);
  fs.readFile(p, (err, buf) => {
    if (err) { res.writeHead(404, {'Content-Type':'text/plain'}); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(buf);
  });
}

http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/healthz') { res.writeHead(200, {'Content-Type':'text/plain'}); return res.end('ok'); }
  if (PAGES[url]) return send(res, PAGES[url]);
  const name = url.replace(/^\/+/, '');
  if (STATIC_WHITELIST.has(name)) return send(res, name);
  // default: owner app
  res.writeHead(302, {'Location': '/owner'});
  res.end();
}).listen(PORT, () => console.log('cph-owner-app on :' + PORT));
