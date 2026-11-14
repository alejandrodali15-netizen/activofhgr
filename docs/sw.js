// Service worker: guarda los archivos de la app para que abra sin señal.
// Al publicar una versión nueva, cambia CACHE para que los teléfonos la descarguen.
const CACHE = 'activo-fijo-v1.1.1';
const ARCHIVOS = ['./', 'index.html', 'css/app.css', 'js/config.js', 'js/db.js', 'js/api.js', 'js/foto.js', 'js/app.js',
                  'manifest.json', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

// Primero la red (para recibir siempre la versión publicada); sin señal o con señal lenta, lo guardado.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;   // el servidor (Apps Script) no se intercepta
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const red = fetch(e.request, {cache: 'no-cache'}).then(resp => {
      if (resp.ok) cache.put(e.request, resp.clone());
      return resp;
    });
    const guardado = await cache.match(e.request, {ignoreSearch: true});
    if (!guardado) return red.catch(() => cache.match('index.html'));
    const lento = new Promise(ok => setTimeout(() => ok(guardado), 3000));
    return Promise.race([red.catch(() => guardado), lento]);
  })());
});
