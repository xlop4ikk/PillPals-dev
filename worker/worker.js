/**
 * Пилюлькин День — Push-сервер на Cloudflare Workers.
 *
 * Чистый Web Crypto: VAPID JWT (ES256) + шифрование payload (aes128gcm, RFC 8291).
 * Без npm-зависимостей — web-push в Workers не работает (нет node:crypto ECDH).
 *
 * Эндпоинты:
 *   GET  /api/vapid-public-key — публичный VAPID-ключ
 *   POST /api/subscribe        — { subscription, pills?, tzOffsetMin? } — сохранить подписку
 *   POST /api/unsubscribe      — { endpoint } — удалить подписку
 *   POST /api/pills/save       — { pills, tzOffsetMin } — сохранить расписание
 *   GET  /api/debug            — состояние
 *
 * Cron: каждую минуту проверяет расписание и рассылает push.
 *
 * Переменные (worker/wrangler.toml → [vars]):
 *   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, SITE_URL
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// ===== Base64url helpers =====
function b64urlEncode(bytes) {
  let bin = "";
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str) {
  let s = str.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function utf8(str) {
  return new TextEncoder().encode(str);
}

function concatBytes(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

function u32be(n) {
  return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
}

// ===== HKDF =====
async function hkdf(ikm, salt, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    key,
    length * 8
  );
  return new Uint8Array(bits);
}

// ===== VAPID JWT (ES256) =====
async function vapidAuthHeader(endpoint, publicKeyB64, privateKeyB64, subject) {
  const aud = new URL(endpoint).origin;

  // Приватный ключ из base64url → JWK
  const pubBytes = b64urlDecode(publicKeyB64); // 65 байт: 0x04 || X || Y
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: b64urlEncode(pubBytes.slice(1, 33)),
    y: b64urlEncode(pubBytes.slice(33, 65)),
    d: privateKeyB64,
    ext: true,
  };
  const key = await crypto.subtle.importKey(
    "jwk", jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false, ["sign"]
  );

  const enc = (o) => b64urlEncode(utf8(JSON.stringify(o)));
  const unsigned = enc({ typ: "JWT", alg: "ES256" }) + "." +
    enc({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject });

  const sigBuf = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    utf8(unsigned)
  );
  // Подпись ES256 в JWT — raw r||s, тот же формат, что отдаёт Web Crypto
  return `vapid t=${unsigned}.${b64urlEncode(new Uint8Array(sigBuf))}, k=${publicKeyB64}`;
}

// ===== Шифрование payload (aes128gcm, RFC 8291) =====
async function encryptPayload(payloadStr, sub) {
  if (!sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    throw new Error("subscription missing keys");
  }
  const uaPublicRaw = b64urlDecode(sub.keys.p256dh);
  const authSecret = b64urlDecode(sub.keys.auth);

  // Эфемерная пара ключей сервера
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const ephPublicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));

  // Общий секрет ECDH
  const uaPublic = await crypto.subtle.importKey(
    "raw", uaPublicRaw, { name: "ECDH", namedCurve: "P-256" }, false, []
  );
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaPublic }, eph.privateKey, 256)
  );

  // IKM
  const ikm = await hkdf(
    authSecret, ecdhSecret,
    concatBytes(utf8("WebPush: info"), new Uint8Array([0]), uaPublicRaw, ephPublicRaw),
    32
  );

  // Соль = эфемерный публичный ключ
  const cek = await hkdf(ikm, ephPublicRaw, utf8("Content-Encoding: aes128gcm\u0000"), 16);
  const nonce = await hkdf(ikm, ephPublicRaw, utf8("Content-Encoding: nonce\u0000"), 12);

  // Запись: payload || 0x02 || нулевой паддинг (всего rs - 17)
  // rs=4026: 70 байт заголовка aes128gcm + 4026 = 4096 — лимит Apple Push (413 иначе)
  const rs = 4026;
  const payloadBytes = utf8(payloadStr);
  const paddingLen = rs - 17 - payloadBytes.length;
  if (paddingLen < 0) throw new Error("payload too large");
  const record = concatBytes(payloadBytes, new Uint8Array([2]), new Uint8Array(paddingLen));

  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, record)
  );

  // Заголовок aes128gcm: salt(65) || rs(4 BE) || idlen(1) = 0
  const body = concatBytes(ephPublicRaw, u32be(rs), new Uint8Array([0]), ciphertext);
  return body;
}

// ===== Отправка push =====
async function sendPush(subscription, env, payload) {
  try {
    const auth = await vapidAuthHeader(
      subscription.endpoint,
      env.VAPID_PUBLIC_KEY,
      env.VAPID_PRIVATE_KEY,
      env.VAPID_SUBJECT || "mailto:admin@example.com"
    );

    const headers = {
      TTL: "86400",
      Urgency: "high",
      Authorization: auth,
    };

    let body;
    if (payload) {
      body = await encryptPayload(JSON.stringify(payload), subscription);
      headers["Content-Type"] = "application/octet-stream";
      headers["Content-Encoding"] = "aes128gcm";
    }

    const resp = await fetch(subscription.endpoint, { method: "POST", headers, body });
    return { ok: resp.status === 201 || resp.status === 200, status: resp.status };
  } catch (e) {
    return { ok: false, status: 0, error: String(e.message || e) };
  }
}

// ===== KV: подписки (массив в одном ключе) =====
async function getSubscriptions(env) {
  const store = await env.KV_NAMESPACE.get("subscriptions", "json");
  return (store && store.subscriptions) || [];
}

async function saveSubscriptions(env, subs) {
  await env.KV_NAMESPACE.put("subscriptions", JSON.stringify({ subscriptions: subs }));
}

// ===== KV: расписание =====
async function getSchedule(env) {
  const rec = await env.KV_NAMESPACE.get("user:pills", "json");
  return rec || { pills: [], tzOffsetMin: 0, notifiedToday: {} };
}

async function saveSchedule(env, rec) {
  await env.KV_NAMESPACE.put("user:pills", JSON.stringify(rec));
}

// ===== HTTP-обработчик =====
async function handleRequest(request, env) {
  const url = new URL(request.url);
  const method = request.method;

  if (url.pathname === "/api/health") {
    return json({ ok: true, time: new Date().toISOString() });
  }

  // Публичный VAPID-ключ для подписки
  if (url.pathname === "/api/vapid-public-key" && method === "GET") {
    return new Response(env.VAPID_PUBLIC_KEY, {
      headers: { ...CORS, "Content-Type": "text/plain" },
    });
  }

  // Сохранение подписки (+ сразу расписание, если прислано)
  if (url.pathname === "/api/subscribe" && method === "POST") {
    const data = await request.json();
    if (!data.subscription || !data.subscription.endpoint) {
      return json({ success: false, error: "missing subscription" }, 400);
    }

    const subs = await getSubscriptions(env);
    const rec = { subscription: data.subscription, tzOffsetMin: data.tzOffsetMin || 0, addedAt: Date.now() };
    const idx = subs.findIndex(s => s.subscription.endpoint === data.subscription.endpoint);
    if (idx !== -1) subs[idx] = rec; else subs.push(rec);
    await saveSubscriptions(env, subs);

    // Если прислан schedule — сохраняем
    if (Array.isArray(data.pills)) {
      const sched = await getSchedule(env);
      sched.pills = data.pills;
      sched.tzOffsetMin = data.tzOffsetMin || 0;
      await saveSchedule(env, sched);
    }

    return json({ success: true });
  }

  // Удаление подписки
  if (url.pathname === "/api/unsubscribe" && method === "POST") {
    const data = await request.json();
    if (!data.endpoint) return json({ success: false, error: "missing endpoint" }, 400);
    const subs = await getSubscriptions(env);
    await saveSubscriptions(env, subs.filter(s => s.subscription.endpoint !== data.endpoint));
    return json({ success: true });
  }

  // Сохранение расписания
  if (url.pathname === "/api/pills/save" && method === "POST") {
    const data = await request.json();
    const sched = await getSchedule(env);
    sched.pills = data.pills || [];
    sched.tzOffsetMin = data.tzOffsetMin || 0;
    await saveSchedule(env, sched);
    return json({ success: true, saved: sched.pills.length });
  }

  // ВРЕМЕННЫЙ тестовый push (для отладки, будет удалён)
  if (url.pathname === "/api/test-push" && method === "POST") {
    const subs = await getSubscriptions(env);
    if (subs.length === 0) return json({ success: false, error: "Нет подписок" });
    const siteUrl = (env.SITE_URL || "").replace(/\/+$/, "");
    let sent = 0;
    const errors = [];
    for (const rec of subs) {
      const result = await sendPush(rec.subscription, env, {
        title: "💊 Тест Пилюлькина",
        body: "Проверка доставки " + new Date().toISOString().slice(11, 19),
        icon: siteUrl + "/icons/PillPalls_icon-192.png",
        url: siteUrl || "/",
      });
      if (result.ok) sent++;
      else errors.push(result);
    }
    return json({ success: sent > 0, sent, errors });
  }

  // Debug
  if (url.pathname === "/api/debug" && method === "GET") {
    const subs = await getSubscriptions(env);
    const sched = await getSchedule(env);
    return json({
      ok: true,
      vapidConfigured: !!env.VAPID_PUBLIC_KEY && !!env.VAPID_PRIVATE_KEY,
      subscriptions: subs.length,
      pillsSaved: (sched.pills || []).length,
      tzOffsetMin: sched.tzOffsetMin,
    });
  }

  return json({ error: "not found" }, 404);
}

// ===== Cron: напоминания =====
async function checkReminders(env) {
  try {
    if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
      console.warn("VAPID keys not configured");
      return;
    }

    const subs = await getSubscriptions(env);
    if (subs.length === 0) return;

    const sched = await getSchedule(env);
    const pills = sched.pills || [];
    if (pills.length === 0) return;

    // Локальное время пользователя (tzOffsetMin = getTimezoneOffset(), минуты)
    const offset = sched.tzOffsetMin || 0;
    const userNow = new Date(Date.now() - offset * 60000);
    const todayKey = userNow.getFullYear() + "-" +
      String(userNow.getMonth() + 1).padStart(2, "0") + "-" +
      String(userNow.getDate()).padStart(2, "0");
    const userHHMM = String(userNow.getHours()).padStart(2, "0") + ":" +
      String(userNow.getMinutes()).padStart(2, "0");

    sched.notifiedToday = sched.notifiedToday || {};

    // Какие таблетки пора принять
    const due = [];
    const dueKeys = [];
    for (const pill of pills) {
      if (!pill.time) continue;
      if (pill.dateStart && todayKey < pill.dateStart) continue;
      if (pill.dateEnd && todayKey > pill.dateEnd) continue;
      if (pill.takenDates && pill.takenDates[todayKey]) continue; // уже принята
      if (pill.time > userHHMM) continue;
      const nk = pill.id + ":" + todayKey;
      if (sched.notifiedToday[nk]) continue; // уже уведомляли
      due.push((pill.name || "Лекарство") + (pill.dose ? " (" + pill.dose + ")" : ""));
      dueKeys.push(nk);
    }

    if (due.length === 0) return;

    const siteUrl = (env.SITE_URL || "").replace(/\/+$/, "");
    const payload = {
      title: "💊 Время принять таблетки!",
      body: "Пора принять:\n" + due.map(n => "💊 " + n).join("\n"),
      icon: siteUrl + "/icons/PillPalls_icon-192.png",
      url: siteUrl || "/",
    };

    let sent = 0;
    const removed = [];
    for (const rec of subs) {
      const result = await sendPush(rec.subscription, env, payload);
      if (result.ok) sent++;
      else if (result.status === 404 || result.status === 410) removed.push(rec.subscription.endpoint);
      else console.log("Push failed:", JSON.stringify(result), "endpoint:", rec.subscription.endpoint.slice(0, 60));
    }
    console.log(`Push: due=${due.length} sent=${sent} removed=${removed.length}`);

    if (removed.length) {
      await saveSubscriptions(env, subs.filter(s => !removed.includes(s.subscription.endpoint)));
    }

    // Помечаем уведомлёнными (защита от повторной отправки)
    if (sent > 0) {
      for (const nk of dueKeys) sched.notifiedToday[nk] = Date.now();
    }
    // Чистим старые флаги (оставляем только сегодня)
    const cleaned = {};
    for (const k in sched.notifiedToday) {
      if (k.endsWith(":" + todayKey)) cleaned[k] = sched.notifiedToday[k];
    }
    sched.notifiedToday = cleaned;
    await saveSchedule(env, sched);
  } catch (e) {
    console.error("Cron error:", e);
  }
}

// ===== Точка входа =====
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    try {
      return await handleRequest(request, env);
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkReminders(env));
  },
};
