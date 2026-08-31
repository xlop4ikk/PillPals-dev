/**
 * Пилюлькин День — Push-сервер на Cloudflare Workers.
 *
 * Web Push:
 * - VAPID / ES256 (RFC 8292)
 * - aes128gcm payload encryption (RFC 8291 / RFC 8188)
 * - Web Crypto API, без npm-зависимостей
 *
 * Endpoints:
 *   GET  /api/health
 *   GET  /api/vapid-public-key
 *   POST /api/subscribe
 *   POST /api/unsubscribe
 *   POST /api/pills/save
 *   GET  /api/debug
 *
 * Cron: каждую минуту проверяет расписание и отправляет push.
 *
 * Environment:
 *   VAPID_PUBLIC_KEY — обычная [vars]
 *   VAPID_PRIVATE_KEY — Cloudflare Secret (wrangler secret put VAPID_PRIVATE_KEY)
 *   VAPID_SUBJECT — [vars], например mailto:you@example.com
 *   SITE_URL — [vars]
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const WEB_PUSH_MAX_BODY = 4096;
const AES128GCM_RS = 4096;
const AES128GCM_TAG_LENGTH = 16;
const AES128GCM_HEADER_LENGTH = 16 + 4 + 1 + 65; // salt + rs + idlen + keyid
const MAX_PLAINTEXT = WEB_PUSH_MAX_BODY - AES128GCM_HEADER_LENGTH - 1 - AES128GCM_TAG_LENGTH;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// ===== Base64url helpers =====
function b64urlEncode(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str) {
  let s = String(str).replace(/-/g, "+").replace(/_/g, "/");
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
  let offset = 0;
  for (const arr of arrays) {
    out.set(arr, offset);
    offset += arr.length;
  }
  return out;
}

function u32be(n) {
  return new Uint8Array([
    (n >>> 24) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 8) & 0xff,
    n & 0xff,
  ]);
}

function assertLength(bytes, expected, name) {
  if (bytes.length !== expected) {
    throw new Error(`${name} must be ${expected} bytes, got ${bytes.length}`);
  }
}

// ===== HKDF =====
async function hkdf(ikm, salt, info, length) {
  const key = await crypto.subtle.importKey(
    "raw",
    ikm,
    "HKDF",
    false,
    ["deriveBits"]
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info,
    },
    key,
    length * 8
  );

  return new Uint8Array(bits);
}

// ===== Парсинг приватного ключа: поддержка JWK JSON и base64url "d" =====
// Приватный ключ принимается в ЛЮБОМ из двух форматов:
//   а) полная JWK JSON-строка {"kty":"EC","crv":"P-256","x":"...","y":"...","d":"..."}
//      (именно её выводит tools/gen_vapid.js)
//   б) base64url-строка "d" (43 символа) — тогда x/y берутся из публичного ключа
function parsePrivateJwk(publicKeyB64, privateKeyRaw) {
  const raw = String(privateKeyRaw || "").trim()
    // если секрет сохранился вместе с внешними кавычками — снимаем их
    .replace(/^["']|["']$/g, "");

  if (raw.startsWith("{")) {
    const parsed = JSON.parse(raw);
    if (!parsed.d || !parsed.x || !parsed.y) {
      throw new Error("VAPID_PRIVATE_KEY JWK must contain x, y and d fields");
    }
    // Оставляем только нужные поля: key_ops/use из Node-экспорта ломают importKey
    return {
      kty: "EC",
      crv: "P-256",
      x: String(parsed.x),
      y: String(parsed.y),
      d: String(parsed.d),
      ext: true,
    };
  }

  if (raw.startsWith("-----BEGIN")) {
    throw new Error("VAPID_PRIVATE_KEY looks like PEM — не поддерживается. Нужен JWK JSON или base64url 'd' (см. tools/gen_vapid.js)");
  }

  const pubBytes = b64urlDecode(publicKeyB64);
  assertLength(pubBytes, 65, "VAPID public key");
  if (pubBytes[0] !== 0x04) {
    throw new Error("VAPID public key is not an uncompressed P-256 point");
  }

  const dBytes = b64urlDecode(raw);
  assertLength(dBytes, 32, "VAPID private key 'd'");

  return {
    kty: "EC",
    crv: "P-256",
    x: b64urlEncode(pubBytes.slice(1, 33)),
    y: b64urlEncode(pubBytes.slice(33, 65)),
    d: raw,
    ext: true,
  };
}

// ===== Самодиагностика VAPID-ключей (для /api/debug, ключ не раскрываем) =====
async function vapidSelfTest(env) {
  const raw = String(env.VAPID_PRIVATE_KEY || "").trim();
  const info = {
    format: raw.startsWith("{") ? "jwk-json"
      : raw.startsWith("-----BEGIN") ? "pem"
      : "raw-string",
    length: raw.length,
    firstChars: raw.slice(0, 5),
    dBytes: null,
    importOk: false,
    error: null,
  };
  try {
    const jwk = parsePrivateJwk(env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
    info.dBytes = b64urlDecode(jwk.d).length;
    const key = await crypto.subtle.importKey(
      "jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]
    );
    // Пробная подпись — полная проверка ключа
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8("selftest"));
    info.importOk = true;
  } catch (e) {
    info.error = String(e?.message || e);
  }
  return info;
}

async function vapidAuthHeader(endpoint, publicKeyB64, privateKeyB64, subject) {
  if (!publicKeyB64 || !privateKeyB64) {
    throw new Error("VAPID keys are not configured");
  }

  const aud = new URL(endpoint).origin;
  const pubBytes = b64urlDecode(publicKeyB64);
  assertLength(pubBytes, 65, "VAPID public key");

  const jwk = parsePrivateJwk(publicKeyB64, privateKeyB64);

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );

  const enc = (obj) => b64urlEncode(utf8(JSON.stringify(obj)));
  const header = enc({ typ: "JWT", alg: "ES256" });
  const payload = enc({
    aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject || "mailto:admin@example.com",
  });
  const unsigned = `${header}.${payload}`;

  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    utf8(unsigned)
  );
  const sig = new Uint8Array(signature);
  assertLength(sig, 64, "VAPID ES256 signature");

  return `vapid t=${unsigned}.${b64urlEncode(sig)}, k=${publicKeyB64}`;
}

// ===== Web Push payload encryption (RFC 8291 / RFC 8188 aes128gcm) =====
async function encryptPayload(payloadStr, subscription) {
  if (!subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    throw new Error("subscription missing p256dh/auth keys");
  }

  const uaPublicRaw = b64urlDecode(subscription.keys.p256dh);
  const authSecret = b64urlDecode(subscription.keys.auth);
  assertLength(uaPublicRaw, 65, "subscription p256dh");
  assertLength(authSecret, 16, "subscription auth secret");
  if (uaPublicRaw[0] !== 0x04) {
    throw new Error("subscription p256dh is not an uncompressed P-256 point");
  }

  const payloadBytes = utf8(payloadStr);
  if (payloadBytes.length > MAX_PLAINTEXT) {
    throw new Error(`payload too large: ${payloadBytes.length} > ${MAX_PLAINTEXT} bytes`);
  }

  // Application server generates a fresh ephemeral ECDH key pair per message.
  const eph = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  );

  const ephPublicRaw = new Uint8Array(
    await crypto.subtle.exportKey("raw", eph.publicKey)
  );
  assertLength(ephPublicRaw, 65, "ephemeral public key");

  // ECDH shared secret: ECDH(as_private, ua_public)
  const uaPublic = await crypto.subtle.importKey(
    "raw",
    uaPublicRaw,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );

  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: uaPublic },
      eph.privateKey,
      256
    )
  );

  // RFC 8291 §3.3:
  // PRK_key = HKDF-Extract(auth_secret, ecdh_secret)
  // IKM    = HKDF-Expand(PRK_key, "WebPush: info\0" || ua_public || as_public, 32)
  const keyInfo = concatBytes(
    utf8("WebPush: info"),
    new Uint8Array([0]),
    uaPublicRaw,
    ephPublicRaw
  );
  const ikm = await hkdf(ecdhSecret, authSecret, keyInfo, 32);

  // RFC 8188 / RFC 8291:
  // salt = random 16 bytes for this encrypted message.
  // PRK = HKDF-Extract(salt, IKM)
  // CEK = HKDF-Expand(PRK, "Content-Encoding: aes128gcm\0", 16)
  // NONCE = HKDF-Expand(PRK, "Content-Encoding: nonce\0", 12)
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(
    ikm,
    salt,
    utf8("Content-Encoding: aes128gcm\u0000"),
    16
  );
  const nonce = await hkdf(
    ikm,
    salt,
    utf8("Content-Encoding: nonce\u0000"),
    12
  );

  // One record only. The final record is payload || 0x02 || zero padding.
  // Padding is kept at zero bytes because Apple/Web Push caps the body at 4096 bytes.
  const record = concatBytes(payloadBytes, new Uint8Array([0x02]));

  const aesKey = await crypto.subtle.importKey(
    "raw",
    cek,
    "AES-GCM",
    false,
    ["encrypt"]
  );

  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, tagLength: 128 },
      aesKey,
      record
    )
  );

  // aes128gcm binary header (RFC 8188):
  //   salt (16) || rs (4) || idlen (1) || keyid (65)
  // Here keyid is the uncompressed application-server ECDH public key.
  const header = concatBytes(
    salt,
    u32be(AES128GCM_RS),
    new Uint8Array([ephPublicRaw.length]),
    ephPublicRaw
  );

  const body = concatBytes(header, ciphertext);
  if (body.length > WEB_PUSH_MAX_BODY) {
    throw new Error(`encrypted body too large: ${body.length} bytes`);
  }

  return body;
}

// ===== Push send =====
async function sendPush(subscription, env, payload) {
  try {
    const auth = await vapidAuthHeader(
      subscription.endpoint,
      env.VAPID_PUBLIC_KEY,
      env.VAPID_PRIVATE_KEY,
      env.VAPID_SUBJECT
    );

    const headers = {
      TTL: "86400",
      Urgency: "high",
      Authorization: auth,
    };

    let body = undefined;
    if (payload !== undefined && payload !== null) {
      body = await encryptPayload(JSON.stringify(payload), subscription);
      headers["Content-Type"] = "application/octet-stream";
      headers["Content-Encoding"] = "aes128gcm";
    }

    const response = await fetch(subscription.endpoint, {
      method: "POST",
      headers,
      body,
    });

    let responseBody = "";
    try {
      responseBody = await response.text();
    } catch (_) {
      // Some push services provide no response body.
    }

    return {
      ok: response.status === 201 || response.status === 200 || response.status === 202,
      status: response.status,
      responseBody: responseBody.slice(0, 500),
    };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      error: String(e?.message || e),
    };
  }
}

// ===== KV: subscriptions =====
async function getSubscriptions(env) {
  const store = await env.KV_NAMESPACE.get("subscriptions", "json");
  return (store && store.subscriptions) || [];
}

async function saveSubscriptions(env, subs) {
  await env.KV_NAMESPACE.put("subscriptions", JSON.stringify({ subscriptions: subs }));
}

// ===== KV: schedule =====
async function getSchedule(env) {
  const rec = await env.KV_NAMESPACE.get("user:pills", "json");
  return rec || { pills: [], tzOffsetMin: 0, notifiedToday: {} };
}

async function saveSchedule(env, rec) {
  await env.KV_NAMESPACE.put("user:pills", JSON.stringify(rec));
}

// ===== HTTP =====
async function handleRequest(request, env) {
  const url = new URL(request.url);
  const method = request.method;

  if (url.pathname === "/api/health" && method === "GET") {
    return json({ ok: true, time: new Date().toISOString() });
  }

  if (url.pathname === "/api/vapid-public-key" && method === "GET") {
    if (!env.VAPID_PUBLIC_KEY) return json({ error: "VAPID public key is not configured" }, 500);
    return new Response(env.VAPID_PUBLIC_KEY, {
      headers: { ...CORS, "Content-Type": "text/plain" },
    });
  }

  if (url.pathname === "/api/subscribe" && method === "POST") {
    const data = await request.json();
    if (!data?.subscription?.endpoint) {
      return json({ success: false, error: "missing subscription" }, 400);
    }

    const subs = await getSubscriptions(env);
    const rec = {
      subscription: data.subscription,
      tzOffsetMin: Number.isFinite(data.tzOffsetMin) ? data.tzOffsetMin : 0,
      addedAt: Date.now(),
    };
    const idx = subs.findIndex((s) => s.subscription?.endpoint === data.subscription.endpoint);
    if (idx !== -1) subs[idx] = rec;
    else subs.push(rec);
    await saveSubscriptions(env, subs);

    if (Array.isArray(data.pills)) {
      const sched = await getSchedule(env);
      sched.pills = data.pills;
      sched.tzOffsetMin = Number.isFinite(data.tzOffsetMin) ? data.tzOffsetMin : 0;
      await saveSchedule(env, sched);
    }

    return json({ success: true, subscriptions: subs.length });
  }

  if (url.pathname === "/api/unsubscribe" && method === "POST") {
    const data = await request.json();
    if (!data?.endpoint) return json({ success: false, error: "missing endpoint" }, 400);
    const subs = await getSubscriptions(env);
    await saveSubscriptions(env, subs.filter((s) => s.subscription?.endpoint !== data.endpoint));
    return json({ success: true });
  }

  if (url.pathname === "/api/pills/save" && method === "POST") {
    const data = await request.json();
    const sched = await getSchedule(env);
    sched.pills = Array.isArray(data.pills) ? data.pills : [];
    sched.tzOffsetMin = Number.isFinite(data.tzOffsetMin) ? data.tzOffsetMin : 0;
    await saveSchedule(env, sched);
    return json({ success: true, saved: sched.pills.length });
  }

  if (url.pathname === "/api/debug" && method === "GET") {
    const subs = await getSubscriptions(env);
    const sched = await getSchedule(env);
    return json({
      ok: true,
      vapidConfigured: !!env.VAPID_PUBLIC_KEY && !!env.VAPID_PRIVATE_KEY,
      privateKeyFormat: String(env.VAPID_PRIVATE_KEY || "").trim().startsWith("{")
        ? "jwk-json"
        : "base64url-d",
      vapidSelfTest: await vapidSelfTest(env),
      subscriptions: subs.length,
      pillsSaved: (sched.pills || []).length,
      tzOffsetMin: sched.tzOffsetMin,
      limits: {
        maxPushBody: WEB_PUSH_MAX_BODY,
        maxPlaintext: MAX_PLAINTEXT,
        aes128gcmHeader: AES128GCM_HEADER_LENGTH,
      },
    });
  }

  return json({ error: "not found" }, 404);
}

// ===== Cron =====
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

    const offset = Number.isFinite(sched.tzOffsetMin) ? sched.tzOffsetMin : 0;
    const userNow = new Date(Date.now() - offset * 60000);
    const todayKey =
      userNow.getFullYear() +
      "-" +
      String(userNow.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(userNow.getDate()).padStart(2, "0");
    const userHHMM =
      String(userNow.getHours()).padStart(2, "0") +
      ":" +
      String(userNow.getMinutes()).padStart(2, "0");

    sched.notifiedToday = sched.notifiedToday || {};

    const due = [];
    const dueKeys = [];
    for (const pill of pills) {
      if (!pill.time) continue;
      if (pill.dateStart && todayKey < pill.dateStart) continue;
      if (pill.dateEnd && todayKey > pill.dateEnd) continue;
      if (pill.takenDates?.[todayKey]) continue;
      if (pill.time > userHHMM) continue;

      const key = `${pill.id}:${todayKey}`;
      if (sched.notifiedToday[key]) continue;
      due.push((pill.name || "Лекарство") + (pill.dose ? ` (${pill.dose})` : ""));
      dueKeys.push(key);
    }

    if (due.length === 0) return;

    const siteUrl = (env.SITE_URL || "").replace(/\/+$/, "");
    const payload = {
      title: "💊 Время принять таблетки!",
      body: "Пора принять:\n" + due.map((name) => "💊 " + name).join("\n"),
      icon: siteUrl + "/icons/PillPalls_icon-192.png",
      url: siteUrl || "/",
    };

    let accepted = 0;
    const invalidEndpoints = new Set();

    for (const rec of subs) {
      const result = await sendPush(rec.subscription, env, payload);
      if (result.ok) accepted++;
      else if (result.status === 404 || result.status === 410) {
        invalidEndpoints.add(rec.subscription.endpoint);
      } else {
        console.log(
          "Push failed:",
          JSON.stringify(result),
          "endpoint:",
          String(rec.subscription.endpoint || "").slice(0, 80)
        );
      }
    }

    console.log(`Push: due=${due.length} accepted=${accepted} removed=${invalidEndpoints.size}`);

    if (invalidEndpoints.size) {
      await saveSubscriptions(
        env,
        subs.filter((s) => !invalidEndpoints.has(s.subscription?.endpoint))
      );
    }

    // Mark as notified only when at least one push service accepted the message.
    if (accepted > 0) {
      for (const key of dueKeys) sched.notifiedToday[key] = Date.now();
    }

    const cleaned = {};
    for (const key in sched.notifiedToday) {
      if (key.endsWith(`:${todayKey}`)) cleaned[key] = sched.notifiedToday[key];
    }
    sched.notifiedToday = cleaned;
    await saveSchedule(env, sched);
  } catch (e) {
    console.error("Cron error:", e);
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    try {
      return await handleRequest(request, env);
    } catch (e) {
      console.error("Request error:", e);
      return json({ error: String(e?.message || e) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkReminders(env));
  },
};
