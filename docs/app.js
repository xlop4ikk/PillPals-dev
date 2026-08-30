/* ===== Пилюлькин День — app.js (Medisafe-like) ===== */
(function () {
  "use strict";

  const STORAGE_KEY = "pillpals.pills.v1";
  const STREAK_KEY = "pillpals.streak.v1";
  const LAST_TAKEN_ALL_KEY = "pillpals.lastAllTaken.v1";

  // Push-сервер (Cloudflare Worker)
  const API = "https://pillpals-push.xatabeach42.workers.dev";
  const PUSH_ENABLED_KEY = "pillpals.pushEnabled.v1";

  const TAGLINES = [
    "Ты сегодня уже принял свои волшебные пилюли?",
    "Пора подкрепиться витаминками! 🦸‍♂️",
    "Не забывай про таблетки, а то они обидятся! 😄",
    "Здоровье — это круто! Проверь свои пилюли.",
  ];
  const PRAISE = [
    "Ты супергерой! 🦸",
    "Здоровье — это круто!",
    "Ещё одна пилюля — и ты бессмертен! (шутка)",
    "Так держать! Пилюлькин гордится тобой 💪",
    "Отлично! +1 к здоровью ✨",
    "Молодец! Таблетки счастливые 😊",
  ];
  const MONTHS = ["Январь","Февраль","Март","Апрель","Май","Июнь","Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"];
  const DOW = ["Вс","Пн","Вт","Ср","Чт","Пт","Сб"];

  // Типы лекарств
  const MED_TYPES = {
    tablet:  { icon: "💊", label: "Таблетка" },
    capsule: { icon: "💊", label: "Капсула" },
    shot:    { icon: "💉", label: "Укол" },
    mix:     { icon: "🧪", label: "Смесь" },
    syrup:   { icon: "🥤", label: "Сироп" },
    drops:   { icon: "💧", label: "Капли" },
    ointment:{ icon: "🧴", label: "Мазь" },
    powder:  { icon: "⚗️", label: "Порошок" },
    inhaler: { icon: "🌬️", label: "Ингалятор" },
    spray:   { icon: "💦", label: "Спрей" },
    other:   { icon: "❤️", label: "Другое" },
  };
  function typeIcon(t) { return (MED_TYPES[t] && MED_TYPES[t].icon) || "💊"; }
  function typeLabel(t) { return (MED_TYPES[t] && MED_TYPES[t].label) || "Лекарство"; }

  // DOM
  const $ = (id) => document.getElementById(id);
  const listEl = $("list");
  const calendarEl = $("calendar");
  const calMonthEl = $("calMonth");
  const modal = $("modal");
  const modalTitle = $("modalTitle");
  const nameInput = $("nameInput");
  const doseInput = $("doseInput");
  const timeInput = $("timeInput");
  const toastEl = $("toast");
  const hintEl = $("hint");
  const streakNum = $("streakNum");
  const taglineEl = $("tagline");
  const summaryText = $("summaryText");
  const summaryFill = $("summaryFill");
  const typeGrid = $("typeGrid");
  const dateStartInput = $("dateStartInput");
  const dateEndInput = $("dateEndInput");
  const calPrev = $("calPrev");
  const pushBtn = $("pushBtn");
  const calNext = $("calNext");

  let editingId = null;
  let syncTimer = null;
  let selectedDate = todayStr(); // выбранная в календаре дата
  let selectedType = "tablet";   // выбранный тип лекарства в модалке
  let calMonthDate = new Date(); // первый день показываемого месяца
  calMonthDate.setDate(1);       // всегда 1-е число
  
  // Убедимся что selectedDate совпадает с todayStr()
  if (selectedDate !== todayStr()) {
    selectedDate = todayStr();
  }
  
  /* ---------- Utils ---------- */
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  function pad(n) { return String(n).padStart(2, "0"); }
  function dateStr(d) {
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  function todayStr() { return dateStr(new Date()); }
  function parseDateStr(s) {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
  function nowHHMM() {
    const d = new Date();
    return pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function loadData() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
    catch { return []; }
  }
  function saveData(arr) { localStorage.setItem(STORAGE_KEY, JSON.stringify(arr)); }

  function isTakenOn(pill, ds) {
    return !!(pill.takenDates && pill.takenDates[ds]);
  }

  function isPillActiveOnDate(pill, ds) {
    // Если не указан период — активно всегда
    if (!pill.dateStart && !pill.dateEnd) return true;
    if (pill.dateStart && ds < pill.dateStart) return false;
    if (pill.dateEnd && ds > pill.dateEnd) return false;
    return true;
  }

  /* ---------- Streak ---------- */
  function loadStreak() {
    const raw = localStorage.getItem(STREAK_KEY);
    const last = localStorage.getItem(LAST_TAKEN_ALL_KEY);
    if (!raw) return 0;
    let n = parseInt(raw, 10) || 0;
    if (last && last !== todayStr()) {
      const yest = addDays(new Date(), -1);
      if (last !== dateStr(yest)) n = 0;
    }
    return n;
  }
  function saveStreak(n) { localStorage.setItem(STREAK_KEY, String(n)); }
  function updateStreakDisplay() { streakNum.textContent = loadStreak(); }
  function recomputeStreak() {
    const pills = loadData();
    if (pills.length === 0) { updateStreakDisplay(); return; }
    const today = todayStr();
    const active = pills.filter(p => isPillActiveOnDate(p, today));
    if (active.length === 0) { updateStreakDisplay(); return; }
    const allTaken = active.every(p => isTakenOn(p, today));
    if (allTaken) {
      const last = localStorage.getItem(LAST_TAKEN_ALL_KEY);
      if (last !== today) {
        const n = loadStreak() + 1;
        saveStreak(n);
        localStorage.setItem(LAST_TAKEN_ALL_KEY, today);
        showToast("🎉 Все таблетки приняты! Серия: " + n + " дн.");
      }
    }
    updateStreakDisplay();
  }

  /* ---------- Toast ---------- */
  let toastTimer = null;
  function showToast(msg, ms = 2600) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), ms);
  }

  /* ---------- Звук "дзынь" ---------- */
  let audioCtx = null;
  function playDing() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const ctx = audioCtx;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "triangle";
      o.frequency.setValueAtTime(880, ctx.currentTime);
      o.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.08);
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.5);
      o.connect(g); g.connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + 0.55);
    } catch (e) { /* ignore */ }
  }

  /* ---------- Прогресс-кольцо (за сегодня) ---------- */
  function updateRing() {
    // Удалено — кольцо убрано из интерфейса
  }

  /* ---------- Сводка выбранного дня ---------- */
  function updateSummary() {
    const pills = loadData();
    const active = pills.filter(p => isPillActiveOnDate(p, selectedDate));
    const total = active.length;
    const taken = active.filter(p => isTakenOn(p, selectedDate)).length;
    const d = parseDateStr(selectedDate);
    const label = d.getDate() + " " + MONTHS[d.getMonth()].toLowerCase();
    const isToday = selectedDate === todayStr();
    let prefix = isToday ? "Сегодня" : label;
    if (total === 0) {
      summaryText.textContent = prefix + " — добавь первую таблетку!";
      summaryFill.style.width = "0%";
    } else {
      summaryText.textContent = prefix + ": принято " + taken + " из " + total;
      summaryFill.style.width = (taken / total * 100) + "%";
    }
  }

  /* ---------- Календарь ---------- */
  function dayStatus(ds) {
    const pills = loadData().filter(p => isPillActiveOnDate(p, ds));
    if (pills.length === 0) return "none";
    const taken = pills.filter(p => isTakenOn(p, ds)).length;
    if (taken === 0) return "none";
    if (taken >= pills.length) return "all";
    return "some";
  }

  function renderCalendar() {
    if (!calendarEl) return;
    const today = todayStr();
    const year = calMonthDate.getFullYear();
    const month = calMonthDate.getMonth();

    // Первый день месяца (0=Вс, 1=Пн, ...)
    const firstDay = new Date(year, month, 1);
    const startDow = firstDay.getDay(); // 0=Вс
    // Последнее число месяца
    const lastDate = new Date(year, month + 1, 0).getDate();

    calendarEl.innerHTML = "";

    // Шапка дней недели
    const dowNames = ["Вс","Пн","Вт","Ср","Чт","Пт","Сб"];
    for (let i = 0; i < 7; i++) {
      const header = document.createElement("div");
      header.className = "cal-dow-header";
      header.textContent = dowNames[i];
      calendarEl.appendChild(header);
    }

    // Пустые ячейки до первого дня
    for (let i = 0; i < startDow; i++) {
      const empty = document.createElement("div");
      empty.className = "cal-day other-month";
      calendarEl.appendChild(empty);
    }

    // Дни месяца
    for (let d = 1; d <= lastDate; d++) {
      const date = new Date(year, month, d);
      const ds = dateStr(date);
      const st = dayStatus(ds);
      const cell = document.createElement("div");
      cell.className = "cal-day " + st;
      if (ds === today) cell.classList.add("today");
      if (ds === selectedDate) cell.classList.add("selected");
      cell.dataset.date = ds;
      cell.innerHTML =
        '<span class="dnum">' + d + "</span>" +
        '<span class="dot"></span>';
      cell.addEventListener("click", () => selectDate(ds));
      calendarEl.appendChild(cell);
    }

    // подпись месяца
    calMonthEl.textContent = MONTHS[month] + " " + year;
  }

  function selectDate(ds) {
    selectedDate = ds;
    // Если выбранная дата в другом месяце — переключаем месяц
    const sel = parseDateStr(ds);
    if (sel.getMonth() !== calMonthDate.getMonth() || sel.getFullYear() !== calMonthDate.getFullYear()) {
      calMonthDate = new Date(sel.getFullYear(), sel.getMonth(), 1);
    }
    renderCalendar();
    render();
    updateSummary();
  }

  /* ---------- Список таблеток ---------- */
  function render() {
    const pills = loadData().slice().sort((a, b) => (a.time || "").localeCompare(b.time || ""));
    // Фильтруем: показываем только таблетки, активные на выбранную дату
    const activePills = pills.filter(p => isPillActiveOnDate(p, selectedDate));
    listEl.innerHTML = "";
    if (pills.length === 0) {
      hintEl.classList.remove("hidden");
      listEl.innerHTML = '<div class="empty">Пока нет ни одной таблетки.<br>Нажми «＋» внизу, чтобы добавить! 💊</div>';
      updateRing();
      updateSummary();
      renderCalendar();
      return;
    }
    hintEl.classList.add("hidden");
    if (activePills.length === 0) {
      // Есть таблетки, но ни одна не активна на эту дату
      listEl.innerHTML = '<div class="empty">📅 На эту дату нет активных препаратов.<br>Добавь новую таблетку или измени период у существующей.</div>';
      updateRing();
      updateSummary();
      renderCalendar();
      return;
    }
    const isToday = selectedDate === todayStr();
    activePills.forEach(p => {
      const taken = isTakenOn(p, selectedDate);
      const card = document.createElement("div");
      card.className = "card " + (taken ? "taken" : "pending");
      card.dataset.id = p.id;

      const icon = document.createElement("div");
      icon.className = "pill-icon";
      icon.textContent = taken ? "✅" : typeIcon(p.type);

      const info = document.createElement("div");
      info.className = "info";
      const name = document.createElement("p");
      name.className = "name";
      name.textContent = p.name || "Без названия";
      const meta = document.createElement("p");
      meta.className = "meta";
      const parts = [];
      if (p.type && p.type !== "other") parts.push(typeLabel(p.type));
      if (p.dose) parts.push(p.dose);
      // Показываем период, если задан
      if (p.dateStart && p.dateEnd) {
        const fmt = (s) => s.slice(8,10) + "." + s.slice(5,7) + "." + s.slice(0,4);
        parts.push(fmt(p.dateStart) + "–" + fmt(p.dateEnd));
      }
      meta.textContent = parts.join(" · ");
      const time = document.createElement("span");
      time.className = "time";
      time.textContent = "⏰ " + (p.time || "--:--");
      info.appendChild(name);
      if (parts.length) info.appendChild(meta);
      info.appendChild(time);

      const actions = document.createElement("div");
      actions.className = "actions";

      const takeBtn = document.createElement("button");
      takeBtn.className = "take-btn" + (taken ? " taken" : "");
      takeBtn.textContent = taken ? "✓ Принято" : "Выпил!";
      (function(pillDate) {
        takeBtn.addEventListener("click", (e) => onTake(p.id, e, pillDate));
      })(selectedDate);

      const rowBtns = document.createElement("div");
      rowBtns.className = "card-row";
      const editBtn = document.createElement("button");
      editBtn.className = "icon-btn";
      editBtn.textContent = "✏️";
      editBtn.title = "Редактировать";
      editBtn.addEventListener("click", () => openModal(p.id));
      const delBtn = document.createElement("button");
      delBtn.className = "icon-btn";
      delBtn.textContent = "🗑️";
      delBtn.title = "Удалить";
      delBtn.addEventListener("click", () => onDelete(p.id));
      rowBtns.appendChild(editBtn);
      rowBtns.appendChild(delBtn);

      actions.appendChild(takeBtn);
      actions.appendChild(rowBtns);

      card.appendChild(icon);
      card.appendChild(info);
      card.appendChild(actions);
      listEl.appendChild(card);
    });

    recomputeStreak();
    updateRing();
    updateSummary();
    renderCalendar();
  }

  /* ---------- Действия ---------- */
  function onTake(id, evt, ds) {
    const pills = loadData();
    const p = pills.find(x => x.id === id);
    if (!p) return;
    p.takenDates = p.takenDates || {};
    const dateToMark = ds || selectedDate;
    const wasTaken = !!p.takenDates[dateToMark];
    p.takenDates[dateToMark] = !wasTaken ? { at: Date.now() } : null;
    // сброс флага уведомления только при отметке за сегодня
    if (!wasTaken && dateToMark === todayStr()) p.lastNotified = todayStr();
    saveData(pills);

    if (!wasTaken) {
      spawnSparks(evt.currentTarget);
      playDing();
      showToast(PRAISE[Math.floor(Math.random() * PRAISE.length)]);
    }
    render();
    syncToServer();
  }

  function spawnSparks(btn) {
    const chars = ["✨", "⭐", "💫", "🌟"];
    const rect = btn.getBoundingClientRect();
    for (let i = 0; i < 6; i++) {
      const s = document.createElement("span");
      s.className = "spark";
      s.textContent = chars[i % chars.length];
      s.style.left = (rect.left + rect.width / 2) + "px";
      s.style.top = (rect.top + rect.height / 2) + "px";
      const ang = (Math.PI * 2 * i) / 6 + Math.random() * 0.5;
      const dist = 40 + Math.random() * 30;
      s.style.setProperty("--dx", Math.cos(ang) * dist + "px");
      s.style.setProperty("--dy", Math.sin(ang) * dist + "px");
      document.body.appendChild(s);
      setTimeout(() => s.remove(), 750);
    }
  }

  function onDelete(id) {
    if (!confirm("Удалить эту таблетку?")) return;
    saveData(loadData().filter(p => p.id !== id));
    render();
    syncToServer();
  }

  function syncToServer() {
    // Отправляем расписание на push-сервер, чтобы cron знал, когда слать пуши
    clearTimeout(syncTimer);
    syncTimer = setTimeout(async () => {
      try {
        await fetch(API + "/api/pills/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pills: loadData(),
            tzOffsetMin: new Date().getTimezoneOffset(),
          }),
        });
      } catch (e) { /* офлайн — не критично */ }
    }, 1000);
  }

  /* ---------- Web Push ---------- */
  function urlB64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64);
    const output = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
    return output;
  }

  function pushSupported() {
    return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  }

  function updatePushBtn() {
    if (!pushBtn) return;
    const enabled = localStorage.getItem(PUSH_ENABLED_KEY) === "1";
    pushBtn.textContent = enabled ? "🔔" : "🔕";
    pushBtn.classList.toggle("on", enabled);
    pushBtn.title = enabled ? "Уведомления включены" : "Включить уведомления";
  }

  async function togglePush() {
    if (!pushSupported()) {
      showToast("Пуши не поддерживаются этим браузером 😕");
      return;
    }
    // iOS: пуши только из PWA, добавленной на главный экран (iOS ≥ 16.4)
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const isStandalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone;
    if (isIOS && !isStandalone) {
      showToast("Добавь Пилюлькина на главный экран (Поделиться → «На экран «Домой»»), чтобы получать пуши 📱");
      return;
    }

    const enabled = localStorage.getItem(PUSH_ENABLED_KEY) === "1";
    if (enabled) await unsubscribePush();
    else await subscribePush();
    updatePushBtn();
  }

  async function subscribePush() {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") {
      showToast("Разрешение на уведомления не выдано 🔕");
      return;
    }
    showToast("⏳ Подключаю уведомления...");
    try {
      const reg = await navigator.serviceWorker.ready;
      // Публичный ключ берём с сервера — единый источник правды
      const resp = await fetch(API + "/api/vapid-public-key");
      const vapidPublic = (await resp.text()).trim();

      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlB64ToUint8Array(vapidPublic),
        });
      }
      const save = await fetch(API + "/api/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subscription: sub.toJSON(),
          pills: loadData(),
          tzOffsetMin: new Date().getTimezoneOffset(),
        }),
      });
      const data = await save.json();
      if (data.success) {
        localStorage.setItem(PUSH_ENABLED_KEY, "1");
        showToast("🔔 Уведомления включены! Буду напоминать вовремя");
      } else {
        showToast("❌ " + (data.error || "Ошибка подписки"));
      }
    } catch (e) {
      showToast("❌ Ошибка: " + e.message);
    }
  }

  async function unsubscribePush() {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        fetch(API + "/api/unsubscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        }).catch(() => {});
        await sub.unsubscribe();
      }
      localStorage.setItem(PUSH_ENABLED_KEY, "0");
      showToast("🔕 Уведомления выключены");
    } catch (e) {
      showToast("❌ Ошибка: " + e.message);
    }
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("./sw.js").catch((e) => {
      console.warn("SW registration failed:", e);
    });
  }

  /* ---------- Модальное окно ---------- */
  function buildTypeGrid() {
    typeGrid.innerHTML = "";
    Object.keys(MED_TYPES).forEach(key => {
      const t = MED_TYPES[key];
      const opt = document.createElement("div");
      opt.className = "type-opt";
      opt.dataset.type = key;
      opt.innerHTML = '<span class="ticon">' + t.icon + "</span><span>" + t.label + "</span>";
      opt.addEventListener("click", () => selectType(key));
      typeGrid.appendChild(opt);
    });
  }
  function selectType(key) {
    selectedType = key;
    typeGrid.querySelectorAll(".type-opt").forEach(el => {
      el.classList.toggle("selected", el.dataset.type === key);
    });
  }

  function openModal(id) {
    editingId = id || null;
    if (id) {
      const p = loadData().find(x => x.id === id);
      modalTitle.textContent = "Редактировать";
      nameInput.value = p.name || "";
      doseInput.value = p.dose || "";
      timeInput.value = p.time || "";
      dateStartInput.value = p.dateStart || "";
      dateEndInput.value = p.dateEnd || "";
      selectType(p.type || "tablet");
    } else {
      modalTitle.textContent = "Новое лекарство";
      nameInput.value = "";
      doseInput.value = "";
      dateStartInput.value = "";
      dateEndInput.value = "";
      const d = new Date();
      d.setHours(d.getHours() + 1, 0, 0, 0);
      timeInput.value = pad(d.getHours()) + ":00";
      selectType("tablet");
    }
    modal.hidden = false;
    setTimeout(() => nameInput.focus(), 100);
  }
  function closeModal() { 
    modal.hidden = true; 
    editingId = null; 
  }
  function onSave() {
    const name = nameInput.value.trim();
    const dose = doseInput.value.trim();
    const time = timeInput.value;
    const dateStart = dateStartInput.value || null;
    const dateEnd = dateEndInput.value || null;
    if (!name) { showToast("Введи название лекарства 🙏"); nameInput.focus(); return; }
    if (!time) { showToast("Выбери время ⏰"); return; }
    if (dateStart && dateEnd && dateStart > dateEnd) {
      showToast("Начало периода позже конца 📅"); return;
    }
    const pills = loadData();
    if (editingId) {
      const p = pills.find(x => x.id === editingId);
      p.name = name; p.dose = dose; p.time = time; p.type = selectedType;
      p.dateStart = dateStart; p.dateEnd = dateEnd;
    } else {
      pills.push({ id: uid(), name, dose, time, type: selectedType, dateStart, dateEnd, takenDates: {}, lastNotified: null });
    }
    saveData(pills);
    closeModal();
    render();
    showToast("Сохранено! 💾");
    syncToServer();
  }

  /* ---------- Tagline ---------- */
  function rotateTagline() {
    let i = 0;
    taglineEl.textContent = TAGLINES[i];
    setInterval(() => {
      i = (i + 1) % TAGLINES.length;
      taglineEl.textContent = TAGLINES[i];
    }, 12000);
  }

  /* ---------- Смена дня ---------- */
  let lastDay = todayStr();
  function maybeNewDayReset() {
    const t = todayStr();
    if (t !== lastDay) {
      lastDay = t;
      selectedDate = t;
      const td = parseDateStr(t);
      calMonthDate = new Date(td.getFullYear(), td.getMonth(), 1);
    }
    render();
  }

   /* ---------- Init ---------- */
   function init() {
     $("addBtn").addEventListener("click", () => openModal());
     $("cancelBtn").addEventListener("click", closeModal);
     $("saveBtn").addEventListener("click", onSave);
     $("todayBtn").addEventListener("click", () => {
       selectedDate = todayStr();
       const td = new Date();
       calMonthDate = new Date(td.getFullYear(), td.getMonth(), 1);
       render();
     });
     calPrev.addEventListener("click", () => {
       calMonthDate = new Date(calMonthDate.getFullYear(), calMonthDate.getMonth() - 1, 1);
       renderCalendar();
     });
     calNext.addEventListener("click", () => {
       calMonthDate = new Date(calMonthDate.getFullYear(), calMonthDate.getMonth() + 1, 1);
       renderCalendar();
     });
      modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });
      document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

      // Web Push
      if (pushBtn) {
        pushBtn.addEventListener("click", togglePush);
        updatePushBtn();
      }
      registerServiceWorker();

      buildTypeGrid();
     rotateTagline();
     renderCalendar();
     render();

     setInterval(maybeNewDayReset, 60000);

     const params = new URLSearchParams(location.search);
     if (params.get("action") === "add") openModal();
   }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
