// Service worker: guarda los archivos de la app para que abra sin señal.
// Al publicar una versión nueva, cambia CACHE para que los teléfonos la descarguen.
const CACHE = 'activo-fijo-v1.0.0';
const ARCHIVOS = ['./', 'index.html', 'css/app.css', 'js/config.js', 'js/db.js', 'js/api.js', 'js/foto.js', 'js/app.js',
                  'manifest.json', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;   // el servidor (Apps Script) no se intercepta
  e.respondWith(
    caches.match(e.request, {ignoreSearch: true}).then(r => r || fetch(e.request).then(resp => {
      if (resp.ok) { const copia = resp.clone(); caches.open(CACHE).then(c => c.put(e.request, copia)); }
      return resp;
    }).catch(() => caches.match('index.html')))
  );
});
