/* ===== Пилюлькин День — Service Worker ===== */
const CACHE = "pillpals-v34";
const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icons/PillPalls_icon.png",
  "./icons/PillPalls_icon-192.png",
  "./icons/PillPalls_icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE && key.startsWith("pillpals-"))
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;

      return fetch(req)
        .then((response) => {
          if (response.ok && new URL(req.url).origin === location.origin) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return response;
        })
        .catch(() => caches.match("./index.html"));
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
      if (payload && typeof payload === "object") {
        data = { ...data, ...payload };
      }
    }
  } catch (error) {
    console.warn("Push payload parse failed:", error);
  }

  const url = data.url || "./";
  const options = {
    body: data.body,
    icon: data.icon || "./icons/PillPalls_icon-192.png",
    badge: data.badge || "./icons/PillPalls_icon-192.png",
    tag: "pillpals-" + Date.now(),
    renotify: true,
    data: { url },
  };

  event.waitUntil(
    self.registration
      .showNotification(data.title || "💊 Пилюлькин", options)
      .catch((error) => {
        console.warn("showNotification(full) failed, retrying minimal:", error);
        return self.registration.showNotification(data.title || "💊 Пилюлькин", {
          body: data.body || "Не забудь принять таблетки! 💊",
          data: { url },
        });
      })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "./";

  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });

      for (const client of clients) {
        if (client.url.startsWith(self.location.origin) && "focus" in client) {
          try {
            if ("navigate" in client) await client.navigate(url);
          } catch (_) {
            // Some Safari versions do not allow navigate from notificationclick.
          }
          return client.focus();
        }
      }

      return self.clients.openWindow(url);
    })()
  );
});
