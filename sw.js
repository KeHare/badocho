// バド帖 Service Worker
// 役割：オフライン時の起動と静的アセットのキャッシュ
// Firestoreデータはキャッシュせず常にネットワークから取得

const CACHE_VERSION = 'badcho-v2';
const PRECACHE_ASSETS = [
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache => cache.addAll(PRECACHE_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Firestore / Firebase / 外部CDNは常にネットワーク（キャッシュしない）
  if (url.hostname.includes('firestore.googleapis.com') ||
      url.hostname.includes('firebase') ||
      url.hostname.includes('gstatic.com') ||
      url.hostname.includes('jsdelivr.net') ||
      event.request.method !== 'GET') {
    return;
  }

  // HTML / JS / CSS：ネットワーク優先・落ちたらキャッシュ（更新が即反映される）
  if (/\.(html|js|css)$/.test(url.pathname) || url.pathname === '/' || url.pathname.endsWith('/')) {
    event.respondWith(
      fetch(event.request).then(response => {
        if (response && response.status === 200 && response.type === 'basic') {
          const respClone = response.clone();
          caches.open(CACHE_VERSION).then(cache => cache.put(event.request, respClone));
        }
        return response;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

  // 画像など：キャッシュ優先（変わりにくい）
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response && response.status === 200 && response.type === 'basic') {
          const respClone = response.clone();
          caches.open(CACHE_VERSION).then(cache => cache.put(event.request, respClone));
        }
        return response;
      });
    })
  );
});
