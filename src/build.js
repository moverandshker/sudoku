const fs = require('fs');
const p = f => fs.readFileSync(__dirname + '/' + f, 'utf8');

// One stamp per build: shown in the About section and used as the SW cache name,
// so the version visible in the app identifies the exact cached build.
const now = new Date();
const token = now.getTime().toString(36);
const pad = n => String(n).padStart(2, '0');
const stamp = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) +
  ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes());

let html = p('shell.html')
  .replace('__CSS__', () => p('styles.css'))
  .replace('__ENGINE__', () => p('engine.js'))
  .replace('__APP__', () => p('app.js'))
  .replace('__BUILD__', () => stamp + ' · ' + token);
const icon = 'data:image/png;base64,' + fs.readFileSync(__dirname + '/../icon180.png').toString('base64');
html = html.split('__ICON__').join(icon);

fs.writeFileSync(__dirname + '/dist/index.html', html);

// service worker — cache-first, so it works with the network off (or absent)
const sw = `/* Sudoku offline cache. Nothing here talks to a server other than to fetch
   this app's own two files from wherever you hosted it. */
const CACHE = 'sudoku-v${token}';
const ASSETS = ['./', './index.html'];
self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(() => {}));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match('./index.html')))
  );
});
`;
fs.writeFileSync(__dirname + '/dist/sw.js', sw);
fs.copyFileSync(__dirname + '/../icon180.png', __dirname + '/dist/icon180.png');
fs.copyFileSync(__dirname + '/../icon512.png', __dirname + '/dist/icon512.png');

console.log('dist/index.html', (html.length / 1024).toFixed(1) + ' KB');
