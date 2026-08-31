/* ===== Пилюлькин День — Service Worker ===== */
const CACHE = "pillpals-v32";
const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icons/PillPalls_icon-192.png",
  "./icons/PillPalls_icon-512.png",
];

// Установка: кешируем оболочку приложения
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

// Активация: чистим старый кеш
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch: cache-first с fallback к сети (для офлайн-работы)
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((resp) => {
        // кешируем новые GET-запросы того же происхождения
        if (resp.ok && new URL(req.url).origin === location.origin) {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return resp;
      }).catch(() => caches.match("./index.html"));
    })
  );
});

// ===== Web Push =====
self.addEventListener("push", (event) => {
  let data = {
    title: "💊 Пилюлькин",
    body: "Не забудь принять таблетки! 💊",
    icon: "./icons/PillPalls_icon-192.png",
    url: "./",
  };
  try {
    if (event.data) {
      const payload = event.data.json();
      data = { ...data, ...payload };
    }
  } catch (e) { /* некорректный payload — показываем дефолт */ }

  // Уникальный tag на каждый push: Safari не заменяет по тегу, а Chrome
  // с одинаковым тегом молча подменяет уведомление без звука —
  // из-за этого кажется, что уведомления «не приходят».
  const tag = "pillpals-" + Date.now();

  event.waitUntil((async () => {
    // Сначала показываем уведомление (высший приоритет), только потом всё остальное.
    // Полный набор опций может не поддерживаться — тогда пробуем минимальный.
    const fullOptions = {
      body: data.body,
      icon: data.icon || "./icons/PillPalls_icon-192.png",
      badge: "./icons/PillPalls_icon-192.png",
      tag,
      renotify: true,
      vibrate: [200, 100, 200],
      data: { url: data.url || "./" },
    };
    try {
      await self.registration.showNotification(data.title, fullOptions);
    } catch (e1) {
      // Fallback: только базовые опции, которые поддерживает даже Safari
      try {
        await self.registration.showNotification(data.title, {
          body: data.body,
          tag,
          data: { url: data.url || "./" },
        });
      } catch (e2) {
        // Последний шанс: вообще без опций
        try { await self.registration.showNotification(data.title, { body: data.body }); }
        catch (e3) { /* совсем никак */ }
      }
    }
  })());
});

// Клик по уведомлению — открываем приложение
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "./";
  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of clientList) {
      if (client.url.includes(self.location.origin) && "focus" in client) {
        client.navigate(url);
        return client.focus();
      }
    }
    return self.clients.openWindow(url);
  })());
});
