// Офлайн-кэш + заголовки изоляции (COOP/COEP), чтобы нейросеть работала в несколько потоков.
const V = 'photo-eraser-v2';
const SHELL = ['./', 'index.html', 'app.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-180.png'];

function coi(r) {
  if (!r || r.status === 0 || r.type === 'opaque') return r;
  const h = new Headers(r.headers);
  h.set('Cross-Origin-Embedder-Policy', 'require-corp');
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
}

self.addEventListener('install', (e) => { e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  const heavy = /\/(vendor|models)\//.test(u.pathname);
  e.respondWith(caches.open(V).then(async (c) => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    // движок и модель: из кэша; страница и скрипты: из сети (чтобы приходили обновления), без сети — из кэша
    if (heavy && hit) return coi(hit);
    try {
      const r = await fetch(e.request);
      if (r.ok && (heavy || e.request.mode === 'navigate' || SHELL.some((s) => s !== './' && u.pathname.endsWith('/' + s)))) c.put(e.request, r.clone()).catch(() => {});
      return coi(r);
    } catch (err) {
      const fb = hit || (e.request.mode === 'navigate' ? await c.match('index.html') : null);
      if (fb) return coi(fb);
      throw err;
    }
  }));
});
