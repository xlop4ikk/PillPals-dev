/**
 * Генератор VAPID-ключей для Web Push.
 * Запуск:  node tools/gen_vapid.js
 *
 * Выводит:
 *   VAPID_PUBLIC_KEY  — публичный ключ (applicationServerKey на клиенте)
 *   VAPID_PRIVATE_KEY — приватный ключ в формате `d` (base64url, 43 символа) —
 *                       именно его ожидает worker.js в wrangler.toml
 */
const crypto = require("crypto");

const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
  namedCurve: "P-256",
});

// Публичный ключ в формате "uncompressed point" (65 байт: 0x04 + X[32] + Y[32])
const spkiDer = publicKey.export({ type: "spki", format: "der" });
const point = spkiDer.slice(-65); // последние 65 байт — точка
const vapidPublicKey = point.toString("base64url");

// Приватный ключ — только поле `d` из JWK (raw scalar в base64url)
const privJwk = privateKey.export({ format: "jwk" });
const vapidPrivateKey = privJwk.d;

console.log("=== VAPID keys generated ===\n");
console.log("VAPID_PUBLIC_KEY  (worker/wrangler.toml -> [vars]):");
console.log(vapidPublicKey);
console.log("\nVAPID_PRIVATE_KEY (worker/wrangler.toml -> [vars]):");
console.log(vapidPrivateKey);
console.log("\nDone. Do not commit the private key to a public repo!");
