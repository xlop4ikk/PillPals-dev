/**
 * Differential test: send a push via the battle-tested `web-push` library
 * using the SAME subscription and keys as the Worker.
 * If THIS arrives but the Worker's doesn't -> Worker's manual encryption is buggy.
 *
 * Run:  node tools/push_test_webpush.js
 */
const webpush = require("web-push");

// Keys from worker/wrangler.toml
const PUBLIC_KEY = "BIrwu0FfzyM3JciixxmUGZTh5-OlaX7YQb-q4yfBaLk6cwyKGIhdMsef9KvMBsfUMq9y0p85mJgsvah58nybERo";
const PRIVATE_KEY = "_XMyH9X8UnkIJSGCA0RkAfmztn8QZUU0qPSX8IHVFuo";
const SUBJECT = "mailto:xatabeach42@gmail.com";

// Latest subscription from KV (updated 31.08.2026)
const subscription = {
  endpoint: "https://web.push.apple.com/QED_5Z-sKFEy3PrJi6mtYk4fbUSLzdJM3U_HBlrYIuhoAkJKYCqgIN2rXBGqC8rvFzylw52LUBo97IZX9ytupEgPqmvOoqmqICMhDVcU_ZuQp-_UJmrAK2fFhsh8fx4a312UVu1lKvnX_YGrieYcL3RjshqlZMOka6GP6XqfOgc",
  keys: {
    p256dh: "BDm4a9cGvV5wsITMsCcxcCRWoCIUK28y38WTkQmi7Fygk_KSSJjp1kdaB5YcjpxoPWEchihXKwdu4xrP1nN_eTc",
    auth: "uRACwKHHwiI6edGN7T8IjA",
  },
};

webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);

const payload = JSON.stringify({
  title: "💊 Тест через web-push",
  body: "Если видишь это — эталонная библиотека работает",
});

webpush.sendNotification(subscription, payload)
  .then((res) => {
    console.log("OK, statusCode:", res.statusCode);
  })
  .catch((err) => {
    console.error("FAILED:", err.statusCode, err.body || err.message);
  });
