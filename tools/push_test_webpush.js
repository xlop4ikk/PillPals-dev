/**
 * Differential Web Push test using the battle-tested `web-push` package.
 *
 * This script intentionally contains NO private VAPID key and NO real device
 * subscription. Provide them at runtime via environment variables:
 *
 *   VAPID_PUBLIC_KEY=... \
 *   VAPID_PRIVATE_KEY=... \
 *   VAPID_SUBJECT=mailto:you@example.com \
 *   PUSH_SUBSCRIPTION_JSON='{"endpoint":"...","keys":{"p256dh":"...","auth":"..."}}' \
 *   node tools/push_test_webpush.js
 */

const webpush = require("web-push");

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

const publicKey = required("VAPID_PUBLIC_KEY");
const privateKey = required("VAPID_PRIVATE_KEY");
const subject = process.env.VAPID_SUBJECT || "mailto:admin@example.com";

let subscription;
try {
  subscription = JSON.parse(required("PUSH_SUBSCRIPTION_JSON"));
} catch (error) {
  throw new Error(`PUSH_SUBSCRIPTION_JSON is not valid JSON: ${error.message}`);
}

if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
  throw new Error("Subscription must contain endpoint, keys.p256dh and keys.auth");
}

webpush.setVapidDetails(subject, publicKey, privateKey);

const payload = JSON.stringify({
  title: "💊 Тест через web-push",
  body: "Если видишь это — эталонная библиотека работает",
});

webpush
  .sendNotification(subscription, payload)
  .then((res) => {
    console.log("Accepted by push service, statusCode:", res.statusCode);
  })
  .catch((err) => {
    console.error("Push failed:", err.statusCode, err.body || err.message);
    process.exitCode = 1;
  });
