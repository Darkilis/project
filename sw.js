const CACHE_NAME = 'navigator-v1';
const ASSETS = [
    './',
    './index.html', // или как называется твой главный файл
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.6.0/css/all.min.css',
    'https://unpkg.com/ngraph.graph@20.0.1/dist/ngraph.graph.min.js',
    'https://unpkg.com/ngraph.path@1.3.1/dist/ngraph.path.min.js'
    // Сюда также можно добавить пути к .png и .json, если хочешь полный оффлайн
];

// Установка: кешируем ресурсы
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
    );
});

// Активация: чистим старый кеш
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)));
        })
    );
});

// Перехват запросов: сначала кеш, потом сеть
self.addEventListener('fetch', (event) => {
    event.respondWith(
        caches.match(event.request).then((response) => {
            return response || fetch(event.request);
        })
    );
});