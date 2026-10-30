/* Tempura Yama — Service Worker
 * Estratégias:
 *  - App shell (HTML/CSS/JS/fontes/ícones): pré-cache + stale-while-revalidate.
 *  - Navegação: network-first com fallback para o index em cache (offline).
 *  - /api/menu: network-first com fallback para a última resposta salva.
 *  - Demais chamadas de API: sempre rede (pedidos nunca usam cache).
 */
const VERSION = 'tempura-yama-v1';
const APP_SHELL_CACHE = `${VERSION}-shell`;
const RUNTIME_CACHE = `${VERSION}-runtime`;
const MENU_CACHE = `${VERSION}-menu`;

const APP_SHELL = [
  '/',
  '/index.html',
  '/css/styles.css',
  '/js/app.js',
  '/js/api.js',
  '/js/admin.js',
  '/manifest.webmanifest',
  '/fonts/fraunces-latin.woff2',
  '/fonts/dm-sans-latin.woff2',
  '/icons/favicon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(APP_SHELL_CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch((error) => console.warn('[sw] pré-cache parcial:', error)),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => !key.startsWith(VERSION))
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw error;
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const fetchPromise = fetch(request)
    .then((response) => {
      if (response && response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);

  if (cached) {
    fetchPromise.catch(() => {});
    return cached;
  }

  const response = await fetchPromise;
  if (response) return response;
  return Response.error();
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navegação: sempre devolve o app shell quando offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          const cache = await caches.open(RUNTIME_CACHE);
          cache.put('/index.html', response.clone());
          return response;
        } catch {
          return (
            (await caches.match('/index.html')) ||
            (await caches.match('/')) ||
            new Response(
              '<h1>Tempura Yama</h1><p>Você está offline. Abra o app novamente quando tiver conexão.</p>',
              { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
            )
          );
        }
      })(),
    );
    return;
  }

  if (url.pathname === '/api/menu') {
    event.respondWith(networkFirst(request, MENU_CACHE));
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    // API dinâmica: sem cache. Se cair, o app mostra o estado de erro.
    return;
  }

  if (/\.(?:css|js|woff2|png|svg|webmanifest)$/.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(request, APP_SHELL_CACHE));
  }
});
