"use strict";

/* main.js — Project DELTA application flow (no facial recognition).

   BOOT → STUDENT SELECT → SELECT STUDENT → DASHBOARD → HEALTH DATA
   Student selection is manual: pick from list or register new.
   Health metrics come ONLY from real backend readings.
*/

/* ── Dashboard states ─────────────────────────────────────────── */
const AppState = {
  SELECT: "SELECT",
  LOADING: "LOADING",
  ACTIVE: "ACTIVE",
  ERROR: "ERROR",
};

let appState = AppState.SELECT;
let currentStudent = null;
let lastHealth = null;
let healthTimer = null;
let sessionId = null;
let sseConnection = null;
let sessionActive = false;

/* ── Icons ────────────────────────────────────────────────────── */
const ICONS = {
  droplet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.7s6.5 6.6 6.5 11.3a6.5 6.5 0 1 1-13 0C5.5 9.3 12 2.7 12 2.7Z"/></svg>',
  lungs:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v8"/><path d="M9 8c-2.5 0-4.5 2-4.5 4.5V17a3 3 0 0 0 4.7 2.5L11 18v-4"/><path d="M15 8c2.5 0 4.5 2 4.5 4.5V17a3 3 0 0 1-4.7 2.5L13 18v-4"/></svg>',
  flask:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2v6L4.5 18a2.4 2.4 0 0 0 2.1 3.5h10.8a2.4 2.4 0 0 0 2.1-3.5L14 8V2"/><path d="M8 2h8"/><path d="M7 15h10"/></svg>',
};

const METRIC_CARDS = [
  { key: "electrolytes", sel: "#card-electrolytes", decimals: 1 },
  { key: "hydration",    sel: "#card-hydration",    decimals: 1 },
  { key: "stress",       sel: "#card-stress",       decimals: 1 },
];
const BREAKDOWN_CARDS = [
  { key: "sodium",  sel: "#card-sodium",  decimals: 1 },
  { key: "lactate", sel: "#card-lactate", decimals: 2 },
];

/* ── Boot overlay ─────────────────────────────────────────────── */
const bootMessages = ["LOADING SYSTEM...", "CONNECTING TO DATABASE...", "INITIALIZING SENSORS...", "SYSTEM READY"];
function runBootSequence(done) {
  const overlay = document.getElementById("bootOverlay");
  const statusEl = document.getElementById("bootStatus");
  const bar = document.getElementById("bootBar");
  if (!overlay) { if (done) done(); return; }
  let i = 0;
  const step = () => {
    if (statusEl && bootMessages[i]) statusEl.textContent = bootMessages[i];
    if (bar) bar.style.width = `${Math.round(((i + 1) / bootMessages.length) * 100)}%`;
    i += 1;
    if (i < bootMessages.length) setTimeout(step, 350);
    else setTimeout(() => { overlay.classList.add("hide"); setTimeout(() => { overlay.style.display = "none"; if (done) done(); }, 500); }, 300);
  };
  step();
  setTimeout(() => { if (overlay && overlay.style.display !== "none") { overlay.classList.add("hide"); overlay.style.display = "none"; if (done) done(); } }, 4000);
}

/* ── Clock ────────────────────────────────────────────────────── */
function tickClock() {
  const now = new Date();
  const pad = n => String(n).padStart(2, "0");
  const el = document.getElementById("clock");
  if (el) el.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}
setInterval(tickClock, 1000);

/* ── Status banner ────────────────────────────────────────────── */
const statusBanner = document.getElementById("statusBanner");
const scannerOverlay = document.getElementById("scannerOverlay");
function setState(state, detail) {
  appState = state;
  if (!statusBanner) return;
  const map = {
    [AppState.SELECT]:  { cls: "",    text: "SELECT A STUDENT TO BEGIN MONITORING" },
    [AppState.LOADING]: { cls: "info", text: "LOADING STUDENT PROFILE..." },
    [AppState.ACTIVE]:  { cls: "ok",  text: "HEALTH MONITORING ACTIVE" },
    [AppState.ERROR]:   { cls: "err", text: detail || "SYSTEM ERROR" },
  };
  const def = map[state] || { cls: "", text: "" };
  statusBanner.className = `status-banner ${def.cls}`;
  statusBanner.textContent = detail && state !== AppState.ERROR ? `${def.text} \u2014 ${detail}` : def.text;

  if (scannerOverlay) {
    scannerOverlay.classList.add("active");
    scannerOverlay.classList.toggle("hide", state === AppState.ACTIVE);
  }
}

/* ── Debug bar ────────────────────────────────────────────────── */
const debugDot = document.getElementById("debugDot");
const debugText = document.getElementById("debugText");
function setDebug(msg, color) {
  if (debugText) debugText.textContent = msg;
  if (debugDot) { debugDot.className = "debug-dot"; if (color) debugDot.classList.add(color); }
}

/* ── Guidance toast ───────────────────────────────────────────── */
const guidanceToast = document.getElementById("guidanceToast");
const guidanceText = document.getElementById("guidanceText");
let guidanceTimer = null;
function showGuidance(msg, persistent) {
  if (!guidanceToast || !msg) return;
  if (guidanceText) guidanceText.textContent = msg;
  guidanceToast.style.display = "flex";
  clearTimeout(guidanceTimer);
  if (!persistent) guidanceTimer = setTimeout(() => { if (guidanceToast) guidanceToast.style.display = "none"; }, 3000);
}
function hideGuidance() {
  if (guidanceToast) guidanceToast.style.display = "none";
  clearTimeout(guidanceTimer);
}

/* ══════════════════════════════════════════════════════════════
   IDENTITY PANEL
   ══════════════════════════════════════════════════════════════ */

function renderIdentity(student) {
  const n = document.querySelector("[data-role=patient-name]");
  const id = document.querySelector("[data-role=patient-id]");
  const a = document.querySelector("[data-role=patient-age]");
  const w = document.querySelector("[data-role=patient-weight]");
  if (!student) {
    if (n) n.textContent = "--";
    if (id) { id.textContent = "ID --"; id.classList.add("dim"); }
    if (a) a.textContent = "--";
    if (w) w.textContent = "--";
    return;
  }
  const age = student.age != null ? student.age : student.legacyAge;
  if (n) n.textContent = student.name || "--";
  if (id) {
    id.textContent = student.studentCode != null ? `ID ${student.studentCode}` : "ID --";
    id.classList.remove("dim");
  }
  if (a) a.textContent = age != null ? age : "--";
  if (w) w.textContent = student.weightKg != null ? Number(student.weightKg).toFixed(1) : "--";
}

/* ══════════════════════════════════════════════════════════════
   METRIC CARDS
   ══════════════════════════════════════════════════════════════ */

function statusClass(key) {
  return ({
    good: "st-good", normal: "st-normal", low: "st-low", slight: "st-slight",
    elevated: "st-elevated", high: "st-high", critical: "st-critical",
    standby: "st-standby", nosignal: "st-standby", live: "st-live", recent: "st-recent", stale: "st-stale",
  })[key] || "st-good";
}

function renderCardState(root, metric, decimals) {
  const valEl = root.querySelector("[data-role=value]");
  const stEl = root.querySelector("[data-role=status]");
  const barEl = root.querySelector("[data-role=bar]");
  if (!valEl || !stEl || !barEl || !metric) return;

  const state = metric.state;
  if (metric.value == null || state === "NO_SIGNAL") {
    valEl.textContent = "--";
    stEl.className = `status-pill ${statusClass("nosignal")}`;
    stEl.innerHTML = `<span>NO SIGNAL</span>`;
    barEl.style.width = "0%";
    barEl.className = "bar-fill dim";
    root.title = "";
    return;
  }

  valEl.textContent = Number(metric.value).toFixed(decimals);
  const label = state === "LIVE" ? "LIVE" : state === "RECENT" ? "RECENT" : "STALE";
  stEl.className = `status-pill ${statusClass(state.toLowerCase())}`;
  stEl.innerHTML = `<span>${label}</span>`;
  barEl.style.width = `${barPercent(root.dataset.metric, metric.value)}%`;
  barEl.className = "bar-fill neutral";
  const src = metric.source ? `Source: ${metric.source}` : "";
  const ts = metric.recordedAt ? new Date(metric.recordedAt).toLocaleString() : "";
  root.title = [src, ts].filter(Boolean).join(" \u00B7 ");
}

function barPercent(key, value) {
  const clampPct = p => Math.max(2, Math.min(100, p));
  switch (key) {
    case "sodium":      return clampPct(((value - 125) / 35) * 100);
    case "lactate":     return clampPct((value / 5) * 100);
    case "temperature": return clampPct(((value - 36) / 2.5) * 100);
    default:            return clampPct(value);
  }
}

function setAllMetricsStandby() {
  for (const def of METRIC_CARDS) {
    const root = document.querySelector(def.sel);
    if (!root) continue;
    renderCardState(root, { value: null, state: "NO_SIGNAL" }, def.decimals);
    const stEl = root.querySelector("[data-role=status]");
    if (stEl) {
      stEl.className = `status-pill ${statusClass("standby")}`;
      stEl.innerHTML = `<span>STANDBY</span>`;
    }
  }
  for (const def of BREAKDOWN_CARDS) {
    const root = document.querySelector(def.sel);
    if (!root) continue;
    renderCardState(root, { value: null, state: "NO_SIGNAL" }, def.decimals);
    const stEl = root.querySelector("[data-role=status]");
    if (stEl) {
      stEl.className = `status-pill ${statusClass("standby")}`;
      stEl.innerHTML = `<span>STANDBY</span>`;
    }
  }
  const tempRoot = document.getElementById("card-temp");
  if (tempRoot) {
    renderCardState(tempRoot, { value: null, state: "NO_SIGNAL" }, 1);
    const stEl = tempRoot.querySelector("[data-role=status]");
    if (stEl) { stEl.className = `status-pill ${statusClass("standby")}`; stEl.innerHTML = `<span>STANDBY</span>`; }
  }
  const tempDetEl = document.getElementById("tempDetail");
  if (tempDetEl) { tempDetEl.textContent = "Awaiting sensor data"; tempDetEl.className = "temp-detail mono"; }
  const tempConfEl = document.getElementById("tempConfidence");
  if (tempConfEl) tempConfEl.textContent = "";
  const hydConfEl = document.getElementById("hydrationConfidence");
  if (hydConfEl) hydConfEl.textContent = "";
  lastThermalStressData = null;
}

function renderHealth(health) {
  if (!health || !health.metrics) return;
  /* During session: ALL cards update live. After session: data freezes. */
  if (!sessionActive && sessionResults) return; // frozen — don't overwrite
  if (!sessionActive && !sessionResults) return; // no session yet — standby

  for (const def of METRIC_CARDS) {
    const root = document.querySelector(def.sel);
    if (!root) continue;
    const metric = health.metrics[def.key];
    renderCardState(root, metric, def.decimals);
  }
  for (const def of BREAKDOWN_CARDS) {
    const root = document.querySelector(def.sel);
    if (!root) continue;
    const metric = health.metrics[def.key];
    renderCardState(root, metric, def.decimals);
  }

  /* Update estimated stress from thermal + other sensors */
  updateEstimatedStress(health);
}

/* ── Estimated stress from thermal + sensor fusion ────────────── */
let lastThermalStressData = null;
let lastStressScore = null;

function onThermalStressUpdate(stressData) {
  lastThermalStressData = stressData;
  if (lastHealth) updateEstimatedStress(lastHealth);
}

function updateEstimatedStress(health) {
  if (!window.StressEstimator) return;
  const thermalStress = lastThermalStressData;
  const est = window.StressEstimator.estimate(thermalStress, health);

  const stressRoot = document.getElementById("card-stress");
  if (!stressRoot) {
    if (est.availableSensors.length === 0 && (!thermalStress || !thermalStress.calibrated)) {
      lastStressScore = null;
    } else {
      lastStressScore = est.score;
    }
    if (sessionActive) renderRecommendations();
    return;
  }

  const valEl = stressRoot.querySelector("[data-role=value]");
  const stEl = stressRoot.querySelector("[data-role=status]");
  const barEl = stressRoot.querySelector("[data-role=bar]");

  if (est.availableSensors.length === 0 && (!thermalStress || !thermalStress.calibrated)) {
    if (valEl) valEl.textContent = "--";
    if (stEl) { stEl.className = `status-pill ${statusClass("nosignal")}`; stEl.innerHTML = "<span>NO SIGNAL</span>"; }
    if (barEl) barEl.style.width = "0%";
    lastStressScore = null;
  } else {
    lastStressScore = est.score;
    if (valEl) valEl.textContent = est.score;
    const catInfo = window.StressEstimator.getCategory(est.score);
    if (stEl) {
      stEl.className = `status-pill st-${catInfo.color === "green" ? "good" : catInfo.color === "amber" ? "elevated" : catInfo.color === "orange" ? "slight" : "high"}`;
      stEl.innerHTML = `<span>${est.category.toUpperCase()}</span>`;
    }
    if (barEl) {
      barEl.style.width = `${est.score}%`;
      barEl.className = `bar-fill ${catInfo.color === "green" ? "teal" : catInfo.color === "amber" ? "amber" : catInfo.color === "orange" ? "orange" : "red"}`;
    }
  }
  if (sessionActive) renderRecommendations();
}

/* ══════════════════════════════════════════════════════════════
   RECOMMENDATIONS — derived from DELTA stress score + readings
   ══════════════════════════════════════════════════════════════ */

const recList = document.getElementById("recList");

/* Stress recommendation tiers (score 0-100) */
const STRESS_RECS = [
  {
    max: 24, status: "Low Stress", theme: "green", icon: "droplet",
    recs: [
      "Continue your normal activities.",
      "Maintain regular hydration and rest.",
      "Keep a balanced activity and recovery schedule.",
    ],
  },
  {
    max: 49, status: "Mild Stress", theme: "amber", icon: "lungs",
    recs: [
      "Take a short break and relax before continuing.",
      "Try a few minutes of slow, controlled breathing.",
      "Stay hydrated and avoid unnecessary exertion.",
    ],
  },
  {
    max: 74, status: "Moderate Stress", theme: "amber", icon: "lungs",
    recs: [
      "Take a 5\u201310 minute rest before continuing activity.",
      "Try slow breathing for a few minutes.",
      "Drink water and move to a cooler, comfortable environment if needed.",
      "Recheck your measurements after resting.",
    ],
  },
  {
    max: 89, status: "High Stress Indicator", theme: "red", icon: "lungs",
    recs: [
      "Stop strenuous activity and take a rest.",
      "Try slow, controlled breathing for 5 minutes.",
      "Hydrate and move to a cool, comfortable environment.",
      "Recheck your measurements after resting.",
    ],
  },
  {
    max: 100, status: "Very High Stress Indicator", theme: "red", icon: "lungs",
    recs: [
      "Stop strenuous activity and rest.",
      "Move to a safe, cool, comfortable environment.",
      "Hydrate if appropriate.",
      "Recheck the measurement after resting.",
      "If you feel unwell or have concerning symptoms, tell a parent, teacher, coach, or another trusted adult and seek appropriate medical help.",
    ],
  },
];

function getStressRec(score) {
  for (const tier of STRESS_RECS) {
    if (score <= tier.max) return tier;
  }
  return STRESS_RECS[STRESS_RECS.length - 1];
}

let lastRecSignature = null;

function smoothEnter(el, delayMs) {
  if (!el) return;
  el.classList.add("enter");
  if (delayMs) el.style.animationDelay = `${delayMs}ms`;
  el.addEventListener("animationend", () => {
    el.classList.remove("enter");
    el.style.animationDelay = "";
  }, { once: true });
}

function renderRecommendations() {
  if (!recList) return;
  const m = lastHealth && lastHealth.metrics ? lastHealth.metrics : {};
  const recs = [];

  /* --- Stress score recommendations --- */
  if (lastStressScore != null) {
    const tier = getStressRec(lastStressScore);
    recs.push({
      priority: lastStressScore,
      theme: tier.theme, icon: tier.icon,
      title: `Estimated Stress Indicator \u2014 ${tier.status}`,
      desc: tier.recs.join("<br>"),
    });
  }

  /* --- Hydration recommendations --- */
  if (m.hydration && m.hydration.value != null && m.hydration.state !== "NO_SIGNAL") {
    const val = Number(m.hydration.value);
    const theme = val < 30 ? "red" : val < 50 ? "amber" : "green";
    const title = val < 30 ? "Severe dehydration risk" : val < 50 ? "Hydration is low" : "Hydration adequate";
    const desc = val < 30
      ? `Estimated hydration indicator of ${val.toFixed(1)}% is critically low. Rest immediately and drink water. If symptoms persist, seek medical attention.`
      : val < 50
        ? `Estimated hydration indicator of ${val.toFixed(1)}% is low. Take a break and drink water to restore fluid balance.`
        : `Estimated hydration indicator of ${val.toFixed(1)}%. Continue normal hydration.`;
    recs.push({ priority: val < 30 ? 90 : val < 50 ? 60 : 5, theme, icon: "droplet", title, desc });
  }

  /* --- Temperature recommendation --- */
  if (m.temperature && m.temperature.value != null && m.temperature.state !== "NO_SIGNAL") {
    const val = Number(m.temperature.value);
    const baseline = 36.8;
    const delta = val - baseline;
    if (delta >= 1.5) {
      recs.push({ priority: 80, theme: "red", icon: "flask",
        title: "Temperature elevated",
        desc: `Temperature of ${val.toFixed(1)}\u00B0C is ${delta.toFixed(1)}\u00B0C above baseline. Rest in a cool area and recheck after 10 minutes.` });
    } else if (delta >= 0.7) {
      recs.push({ priority: 50, theme: "amber", icon: "flask",
        title: "Temperature above baseline",
        desc: `Temperature of ${val.toFixed(1)}\u00B0C is slightly above baseline. Monitor closely and rest if needed.` });
    } else {
      recs.push({ priority: 5, theme: "green", icon: "flask",
        title: "Temperature normal",
        desc: `Temperature of ${val.toFixed(1)}\u00B0C is within expected range.` });
    }
  }

  /* --- Sodium recommendation --- */
  if (m.sodium && m.sodium.value != null && m.sodium.state !== "NO_SIGNAL") {
    const val = Number(m.sodium.value);
    if (val < 130 || val > 155) {
      recs.push({ priority: 65, theme: "amber", icon: "flask",
        title: "Sodium level abnormal",
        desc: `Sodium level of ${val.toFixed(1)} mEq/L is outside the normal range (130-155). Review electrolyte balance and recheck.` });
    }
  }

  /* --- Lactate recommendation --- */
  if (m.lactate && m.lactate.value != null && m.lactate.state !== "NO_SIGNAL") {
    const val = Number(m.lactate.value);
    if (val >= 4.0) {
      recs.push({ priority: 70, theme: "red", icon: "flask",
        title: "Lactate level elevated",
        desc: `Lactate level of ${val.toFixed(2)} mmol/L is elevated. This may indicate anaerobic activity. Rest and recheck.` });
    }
  }

  /* --- Sort by priority (highest = most severe) --- */
  recs.sort((a, b) => b.priority - a.priority);

  /* --- Take top 3 --- */
  const selected = recs.slice(0, 3);

  /* --- Fill remaining slots up to exactly 3 with generic guidance --- */
  const genericPool = [
    { priority: -1, theme: "green", icon: "droplet", title: "Recovery guidance",
      desc: "Maintain regular hydration and balanced nutrition throughout the day." },
    { priority: -2, theme: "green", icon: "lungs", title: "Activity guidance",
      desc: "Listen to your body and take breaks as needed during physical activity." },
    { priority: -3, theme: "green", icon: "flask", title: "Monitoring guidance",
      desc: "Regular monitoring helps track trends over time. Check measurements periodically." },
  ];
  while (selected.length < 3 && genericPool.length > 0) {
    selected.push(genericPool.shift());
  }

  const sig = selected.map(r => r.title + "\u0001" + r.desc).join("\u0002");
  if (sig === lastRecSignature) return;
  lastRecSignature = sig;

  recList.innerHTML = "";

  /* --- Render exactly 3 --- */
  for (let i = 0; i < selected.length; i++) {
    const rec = selected[i];
    const node = document.createElement("div");
    node.className = `rec-item theme-${rec.theme}`;
    node.innerHTML = `<div class="rec-icon ${rec.icon}">${ICONS[rec.icon]}</div><div class="rec-body"><div class="rec-title">${rec.title}</div><div class="rec-desc">${rec.desc}</div></div>`;
    smoothEnter(node, i * 70);
    recList.appendChild(node);
  }
}

/* ══════════════════════════════════════════════════════════════
   SSE (Server-Sent Events) — real-time push from server
   ══════════════════════════════════════════════════════════════ */

function connectSSE() {
  if (sseConnection) { sseConnection.close(); sseConnection = null; }
  try {
    const url = window.location.origin + "/api/events";
    sseConnection = new EventSource(url);
    sseConnection.onmessage = () => {}; // heartbeat only
    sseConnection.addEventListener("measurement", (e) => {
      try {
        const data = JSON.parse(e.data);
        if (sessionActive && data.studentCode && currentStudent && data.studentCode == currentStudent.studentCode && !data.duplicate) {
          refreshHealth();
        }
      } catch (_) {}
    });
    sseConnection.onerror = () => {
      // Will auto-reconnect; log once
      console.warn("[SSE] connection lost, retrying...");
    };
  } catch (_) {}
}

function disconnectSSE() {
  if (sseConnection) { sseConnection.close(); sseConnection = null; }
}

/* ══════════════════════════════════════════════════════════════
   SESSION SCORING — sodium/lactate scores + electrolyte index
   ══════════════════════════════════════════════════════════════ */

/* Sodium score: normalize against sweat-sodium reference range 30-60 mmol/L
   Normal (0-17%), Low (18-40%), Moderate (41-63%), High (64-83%), Critical (84-100%) */
function scoreSodium(avgMmoll) {
  if (avgMmoll == null) return null;
  const REF_LOW = 30, REF_HIGH = 60;
  const range = REF_HIGH - REF_LOW;
  const score = Math.round(((avgMmoll - REF_LOW) / range) * 100);
  return Math.max(0, Math.min(100, score));
}

/* Lactate score: normalize against reference range 0.5-5.0 mmol/L
   Low = low exertion (good), High = high exertion (stress indicator) */
function scoreLactate(avgMmol) {
  if (avgMmol == null) return null;
  const REF_LOW = 0.5, REF_HIGH = 5.0;
  const range = REF_HIGH - REF_LOW;
  const score = Math.round(((avgMmol - REF_LOW) / range) * 100);
  return Math.max(0, Math.min(100, score));
}

/* Electrolyte/Metabolic Index = (sodiumScore × 0.5) + (lactateScore × 0.5) */
function electrolyteIndex(sodiumScore, lactateScore) {
  if (sodiumScore == null && lactateScore == null) return null;
  if (sodiumScore == null) return Math.round(lactateScore);
  if (lactateScore == null) return Math.round(sodiumScore);
  return Math.round((sodiumScore * 0.5) + (lactateScore * 0.5));
}

/* Hydration score: weighted composite from session data.
   Uses temperature baseline delta + sodium + lactate. */
function calculateSessionHydration(summaryData) {
  if (!summaryData) return null;
  const components = [];
  let totalWeight = 0;
  let totalScore = 0;

  if (summaryData.sodium) {
    const val = summaryData.sodium.avg;
    const naScore = scoreSodium(val);
    const w = 0.50;
    totalScore += naScore * w;
    totalWeight += w;
    components.push({ name: "Sodium", value: val.toFixed(1) + " mmol/L", weight: "50%", score: naScore });
  }
  if (summaryData.lactate) {
    const val = summaryData.lactate.avg;
    const lacScore = scoreLactate(val);
    const w = 0.50;
    totalScore += lacScore * w;
    totalWeight += w;
    components.push({ name: "Lactate", value: val.toFixed(2) + " mmol/L", weight: "50%", score: lacScore });
  }

  if (totalWeight === 0) return null;

  const value = Math.round(totalScore / totalWeight);
  let label = "Adequate";
  let theme = "green";
  if (value < 30) { label = "Critically Low"; theme = "red"; }
  else if (value < 50) { label = "Low"; theme = "amber"; }
  else if (value < 70) { label = "Moderate"; theme = "amber"; }

  return { value, label, theme, components, measurementCount: components.length };
}

/* After-session results — stored when session ends, displayed until next session */
let sessionResults = null;

const METRIC_LABELS = {
  electrolytes: "Electrolyte %",
  hydration: "Hydration %",
  stress: "Stress %",
  temperature: "Temperature",
  sodium: "Sodium (Na+)",
  lactate: "Lactate",
  heart_rate: "Heart Rate",
  hrv: "HRV",
  breathing: "Breathing Rate",
};

const METRIC_ICONS = {
  electrolytes: "flask",
  hydration: "droplet",
  stress: "lungs",
  temperature: "flask",
  sodium: "flask",
  lactate: "flask",
  heart_rate: "lungs",
  hrv: "lungs",
  breathing: "lungs",
};

function renderSessionSummary(summary, student, results) {
  if (!recList) return;
  recList.innerHTML = "";

  const hasSummary = summary && summary.summary && Object.keys(summary.summary).length > 0;
  const hasMeasurements = summary && summary.measurements && summary.measurements.length > 0;

  if (!hasSummary && !hasMeasurements) {
    const item = document.createElement("div");
    item.className = "rec-item theme-green";
    item.innerHTML = `<div class="rec-icon cyan">${ICONS.droplet}</div><div class="rec-body"><div class="rec-title">SESSION COMPLETE</div><div class="rec-desc">No measurements recorded during this session.</div></div>`;
    recList.appendChild(item);
    return;
  }

  const count = hasMeasurements ? summary.measurements.length : 0;
  const dur = summary.session && summary.session.durationMs != null
    ? `${Math.round(summary.session.durationMs / 1000)}s` : "";

  /* ── 1. Header ── */
  const header = document.createElement("div");
  header.className = "session-summary";
  header.innerHTML = `
    <div class="summary-header">
      <div class="summary-title mono">SESSION COMPLETE</div>
      <div class="summary-meta mono">${student.name || "Student"} (ID ${student.studentCode || "--"}) &middot; ${count} reading${count !== 1 ? "s" : ""}${dur ? " &middot; " + dur : ""}</div>
    </div>
  `;
  recList.appendChild(header);

  /* ── 2. Scoring Model (Sodium + Lactate → Electrolyte Index) ── */
  if (results) {
    const scoreSection = document.createElement("div");
    scoreSection.className = "summary-hydration";

    const naScore = results.sodiumScore;
    const lacScore = results.lactateScore;
    const elIdx = results.electrolyteIndex;

    let naLabel = "N/A", lacLabel = "N/A", idxLabel = "N/A";
    if (naScore != null) naLabel = naScore < 17 ? "Normal" : naScore < 40 ? "Low" : naScore < 63 ? "Moderate" : naScore < 84 ? "High" : "Critical";
    if (lacScore != null) lacLabel = lacScore < 30 ? "Low" : lacScore < 60 ? "Moderate" : lacScore < 85 ? "Elevated" : "High";
    if (elIdx != null) idxLabel = elIdx < 30 ? "Low" : elIdx < 70 ? "Moderate" : "Normal";

    const idxTheme = elIdx != null ? (elIdx < 30 ? "red" : elIdx < 70 ? "amber" : "green") : "green";

    scoreSection.innerHTML = `
      <div class="summary-section-title mono">ELECTROLYTE / METABOLIC INDEX</div>
      <div class="summary-hydration-card theme-${idxTheme}">
        <div class="summary-hydration-value">${elIdx != null ? elIdx : "--"}<span class="metric-unit">%</span></div>
        <div class="summary-hydration-label mono">${idxLabel}</div>
        <div class="summary-hydration-conf mono">Electrolyte Index = (Sodium Score x 0.5) + (Lactate Score x 0.5)</div>
        <div class="summary-hydration-breakdown">
          <div class="hyd-comp"><span class="hyd-comp-name">Sodium Score</span><span class="hyd-comp-val">${naScore != null ? naScore + "%" : "N/A"}</span><span class="hyd-comp-weight">w:50%</span><span class="hyd-comp-score">${naLabel}</span></div>
          <div class="hyd-comp"><span class="hyd-comp-name">Lactate Score</span><span class="hyd-comp-val">${lacScore != null ? lacScore + "%" : "N/A"}</span><span class="hyd-comp-weight">w:50%</span><span class="hyd-comp-score">${lacLabel}</span></div>
        </div>
      </div>
    `;
    recList.appendChild(scoreSection);

    /* ── 2b. Total Hydration ── */
    if (results.hydration) {
      const hydSection = document.createElement("div");
      hydSection.className = "summary-hydration";
      hydSection.innerHTML = `
        <div class="summary-section-title mono">TOTAL HYDRATION (from all data)</div>
        <div class="summary-hydration-card theme-${results.hydration.theme}">
          <div class="summary-hydration-value">${results.hydration.value}<span class="metric-unit">%</span></div>
          <div class="summary-hydration-label mono">${results.hydration.label}</div>
          ${results.hydration.components ? `<div class="summary-hydration-breakdown">${results.hydration.components.map(c => `<div class="hyd-comp"><span class="hyd-comp-name">${c.name}</span><span class="hyd-comp-val">${c.value}</span><span class="hyd-comp-weight">w:${c.weight}</span><span class="hyd-comp-score">score:${c.score}</span></div>`).join("")}</div>` : ""}
        </div>
      `;
      recList.appendChild(hydSection);
    }
  }

  /* ── 3. Summary stats table ── */
  if (hasSummary) {
    const metricOrder = ["temperature", "sodium", "lactate", "electrolytes", "hydration", "stress", "heart_rate", "hrv", "breathing"];
    const allKeys = [...metricOrder.filter(k => summary.summary[k]), ...Object.keys(summary.summary).filter(k => !metricOrder.includes(k))];

    const sectionTitle = document.createElement("div");
    sectionTitle.className = "summary-section-title mono";
    sectionTitle.textContent = "ALL COLLECTED DATA";
    recList.appendChild(sectionTitle);

    const tableWrap = document.createElement("div");
    tableWrap.className = "summary-table-wrap";
    const table = document.createElement("table");
    table.className = "summary-table";
    table.innerHTML = `<thead><tr><th>Metric</th><th>Avg</th><th>Min</th><th>Max</th><th>Last</th><th>n</th></tr></thead>`;
    const tbody = document.createElement("tbody");
    for (const key of allKeys) {
      const s = summary.summary[key];
      const decimals = key === "lactate" ? 2 : 1;
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${METRIC_LABELS[key] || key}</td><td>${s.avg != null ? s.avg.toFixed(decimals) : "--"}</td><td>${s.min != null ? s.min.toFixed(decimals) : "--"}</td><td>${s.max != null ? s.max.toFixed(decimals) : "--"}</td><td>${s.last != null ? s.last.toFixed(decimals) : "--"}</td><td>${s.count || 0}</td>`;
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    tableWrap.appendChild(table);
    recList.appendChild(tableWrap);
  }

  /* ── 4. All individual readings ── */
  if (hasMeasurements) {
    const readTitle = document.createElement("div");
    readTitle.className = "summary-section-title mono";
    readTitle.textContent = "RAW READINGS";
    recList.appendChild(readTitle);

    const readWrap = document.createElement("div");
    readWrap.className = "summary-table-wrap";
    const readTable = document.createElement("table");
    readTable.className = "summary-table";
    readTable.innerHTML = `<thead><tr><th>#</th><th>Time</th><th>Electro</th><th>Hydra</th><th>Stress</th><th>Temp</th><th>Na+</th><th>Lactate</th><th>Source</th></tr></thead>`;
    const rBody = document.createElement("tbody");
    let idx = 1;
    for (const m of summary.measurements) {
      const t = m.recorded_at ? new Date(m.recorded_at) : null;
      const timeStr = t ? `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}:${String(t.getSeconds()).padStart(2, "0")}` : "--";
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${idx}</td><td>${timeStr}</td><td>${m.electrolytes_pct != null ? Number(m.electrolytes_pct).toFixed(1) : "-"}</td><td>${m.hydration_pct != null ? Number(m.hydration_pct).toFixed(1) : "-"}</td><td>${m.stress_pct != null ? Number(m.stress_pct).toFixed(1) : "-"}</td><td>${m.temperature_c != null ? Number(m.temperature_c).toFixed(1) : "-"}</td><td>${m.sodium_meq_l != null ? Number(m.sodium_meq_l).toFixed(1) : "-"}</td><td>${m.lactate_mmol_l != null ? Number(m.lactate_mmol_l).toFixed(2) : "-"}</td><td>${m.source || "-"}</td>`;
      rBody.appendChild(tr);
      idx++;
    }
    readTable.appendChild(rBody);
    readWrap.appendChild(readTable);
    recList.appendChild(readWrap);
  }

  /* ── 5. Recommendations ── */
  if (hasSummary) {
    const recTitle = document.createElement("div");
    recTitle.className = "summary-section-title mono";
    recTitle.textContent = "RECOMMENDATIONS";
    recList.appendChild(recTitle);

    const recContainer = document.createElement("div");
    recContainer.className = "rec-list";
    const lastValues = {};
    for (const key of Object.keys(METRIC_LABELS)) {
      if (summary.summary[key] && summary.summary[key].last != null) {
        lastValues[key] = { value: summary.summary[key].last, source: "session", state: "LIVE" };
      }
    }

    const savedLast = lastHealth;
    const savedStress = lastStressScore;
    lastHealth = { metrics: lastValues };
    lastStressScore = summary.summary.stress ? summary.summary.stress.last : null;
    const savedRecList = recList;
    recList = recContainer;
    lastRecSignature = null;
    renderRecommendations();
    recList = savedRecList;
    lastHealth = savedLast;
    lastStressScore = savedStress;

    if (recContainer.children.length > 0) {
      recList.appendChild(recContainer);
    } else {
      const noRec = document.createElement("div");
      noRec.className = "rec-item theme-green";
      noRec.innerHTML = `<div class="rec-icon green">${ICONS.droplet}</div><div class="rec-body"><div class="rec-title">ALL READINGS WITHIN EXPECTED RANGES</div><div class="rec-desc">No actionable recommendations based on this session's data.</div></div>`;
      recList.appendChild(noRec);
    }
  }

  /* ── 6. Footer ── */
  const footer = document.createElement("div");
  footer.className = "summary-footer mono";
  footer.textContent = "Press START to run another session.";
  recList.appendChild(footer);
}

/* Legacy wrapper called from refreshHealth */
function renderRecommendationsFromHealth() {
  renderRecommendations();
}

/* ══════════════════════════════════════════════════════════════
   MONITORING SESSION + HEALTH POLLING
   ══════════════════════════════════════════════════════════════ */

const HEALTH_POLL_MS = 8000;

function makeClientKey() {
  try { return "web-" + crypto.randomUUID(); }
  catch (e) { return "web-" + Date.now().toString(36) + Math.random().toString(36).slice(2); }
}

async function beginMonitoringSession(student) {
  stopHealthPolling();
  sessionActive = true;
  connectSSE();
  sessionId = makeClientKey();
  try {
    await withRetry(() => window.ApiClient.startSession(sessionId, student.studentCode), 3);
  } catch (e) {
    console.warn("[Main] session start failed:", e.message);
    sessionId = null;
  }
  await refreshHealth();
  healthTimer = setInterval(refreshHealth, HEALTH_POLL_MS);
}

function stopMonitoringSession() {
  stopHealthPolling();
  if (sessionId) {
    window.ApiClient.endSession(sessionId).catch(() => {});
    sessionId = null;
  }
}

function stopHealthPolling() {
  if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
}

async function refreshHealth() {
  if (!currentStudent) return;
  try {
    const health = await window.ApiClient.getHealth(currentStudent.studentCode);
    lastHealth = health;
    renderHealth(health);
    if (sessionActive) renderRecommendations();
    if (health.student && health.student.weightKg != null) {
      currentStudent.weightKg = health.student.weightKg;
      renderIdentity(currentStudent);
    }
  } catch (e) {
    console.warn("[Main] health fetch failed:", e.message);
  }
}

async function withRetry(fn, attempts) {
  let lastErr;
  for (let i = 0; i < (attempts || 3); i++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      if (e.status && e.status < 500) throw e;
      await new Promise(r => setTimeout(r, 1200));
    }
  }
  throw lastErr;
}

/* ══════════════════════════════════════════════════════════════
   STUDENT SELECT PANEL
   ══════════════════════════════════════════════════════════════ */

const studentSelectPanel = document.getElementById("studentSelectPanel");

async function loadStudentPanel() {
  if (!studentSelectPanel) return;
  studentSelectPanel.innerHTML = '<div class="manual-empty mono">Loading students...</div>';

  let students = [];
  try {
    const list = await withRetry(() => window.ApiClient.listStudents(), 3);
    students = Array.isArray(list) ? list : [];
  } catch (e) {
    studentSelectPanel.innerHTML = '<div class="manual-empty mono">Cannot reach server.</div>';
    return;
  }

  studentSelectPanel.innerHTML = "";

  if (students.length === 0) {
    const empty = document.createElement("div");
    empty.className = "manual-empty mono";
    empty.textContent = "No registered students yet.";
    studentSelectPanel.appendChild(empty);
  } else {
    for (const s of students) {
      const b = document.createElement("button");
      b.className = "manual-item";
      b.type = "button";
      b.textContent = `ID ${s.studentCode} \u2014 ${s.name}`;
      b.addEventListener("click", () => enterDashboard(s));
      studentSelectPanel.appendChild(b);
    }
  }

  const reg = document.createElement("button");
  reg.className = "btn-manual";
  reg.textContent = "+ NEW STUDENT";
  reg.addEventListener("click", () => showEnrollModal());
  studentSelectPanel.appendChild(reg);
}

/* ══════════════════════════════════════════════════════════════
   ENROLLMENT MODAL
   ══════════════════════════════════════════════════════════════ */

const enrollModal = document.getElementById("enrollModal");
const enrollNameInput = document.getElementById("enrollNameInput");
const enrollAgeInput = document.getElementById("enrollAgeInput");
const enrollWeightInput = document.getElementById("enrollWeightInput");
const enrollConfirmBtn = document.getElementById("enrollConfirm");
const enrollCancelBtn = document.getElementById("enrollCancel");
const enrollError = document.getElementById("enrollError");

function showEnrollModal() {
  enrollNameInput.value = "";
  enrollAgeInput.value = "";
  enrollWeightInput.value = "";
  enrollError.textContent = "";
  enrollConfirmBtn.disabled = false;
  enrollConfirmBtn.textContent = "SAVE STUDENT";
  enrollModal.style.display = "flex";
  enrollModal.setAttribute("aria-hidden", "false");
  setTimeout(() => enrollNameInput.focus(), 80);
}

function hideEnrollModal() {
  if (window.OnScreenKeyboard) window.OnScreenKeyboard.hide();
  enrollModal.style.display = "none";
  enrollModal.setAttribute("aria-hidden", "true");
}

enrollCancelBtn.addEventListener("click", hideEnrollModal);

enrollModal.addEventListener("click", e => {
  if (e.target === enrollModal) hideEnrollModal();
});

enrollNameInput.addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); enrollAgeInput.focus(); }
});

enrollAgeInput.addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); enrollWeightInput.focus(); }
});

enrollWeightInput.addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); enrollConfirmBtn.click(); }
});

enrollConfirmBtn.addEventListener("click", async () => {
  const name = enrollNameInput.value.trim();
  if (!name) {
    enrollError.textContent = "Please enter the student's name.";
    enrollNameInput.focus();
    return;
  }

  const ageStr = enrollAgeInput.value.trim();
  let age = null;
  if (ageStr) {
    age = Number(ageStr);
    if (!Number.isInteger(age) || age < 1 || age > 150) {
      enrollError.textContent = "Age must be a whole number between 1 and 150.";
      enrollAgeInput.focus();
      return;
    }
  }

  const weightStr = enrollWeightInput.value.trim();
  let weightKg = null;
  if (weightStr) {
    weightKg = Number(weightStr);
    if (isNaN(weightKg) || weightKg < 2 || weightKg > 400) {
      enrollError.textContent = "Weight must be between 2 and 400 kg.";
      enrollWeightInput.focus();
      return;
    }
  }

  enrollError.textContent = "";
  enrollConfirmBtn.disabled = true;
  enrollConfirmBtn.textContent = "SAVING...";
  if (window.OnScreenKeyboard) window.OnScreenKeyboard.hide();

  const payload = { name };
  if (age !== null) payload.age = age;
  if (weightKg !== null) payload.weightKg = weightKg;

  try {
    const student = await window.ApiClient.enroll(payload);
    hideEnrollModal();
    showGuidance(`Student registered \u2014 ID ${student.studentCode}`, true);
    setTimeout(hideGuidance, 4000);
    enterDashboard(student);
  } catch (e) {
    enrollConfirmBtn.disabled = false;
    enrollConfirmBtn.textContent = "SAVE STUDENT";
    enrollError.textContent = e.message === "BACKEND_UNAVAILABLE"
      ? "Cannot reach the server. Check your connection and try again."
      : e.message || "Registration failed. Please try again.";
  }
});

/* ══════════════════════════════════════════════════════════════
   DASHBOARD ENTRY / EXIT
   ══════════════════════════════════════════════════════════════ */

function enterDashboard(student) {
  currentStudent = student;
  renderIdentity(currentStudent);
  setAllMetricsStandby();
  setState(AppState.LOADING);
  lastStressScore = null;
  sessionResults = null;
  lastRecSignature = null;
  recList.innerHTML = "";
  const empty = document.createElement("div");
  empty.className = "rec-empty mono";
  empty.textContent = "PRESS START TO BEGIN MONITORING";
  recList.appendChild(empty);
  showStartButton();
  setState(AppState.ACTIVE);
  setDebug(`MONITORING: ${currentStudent.name} (ID ${currentStudent.studentCode})`, "green");
}

function exitDashboard() {
  stopMonitoringSession();
  disconnectSSE();
  cancelMonitorTimer();
  if (window.ThermalPanel) window.ThermalPanel.stop();
  currentStudent = null;
  lastHealth = null;
  renderIdentity(null);
  setAllMetricsStandby();
  recList.innerHTML = "";
  const empty = document.createElement("div");
  empty.className = "rec-empty mono";
  empty.textContent = "NO SIGNAL \u00B7 AWAITING USER DETECTION";
  recList.appendChild(empty);
  hideStartButton();
  setState(AppState.SELECT);
  setDebug("SELECT A STUDENT", "cyan");
  loadStudentPanel();
}

/* ── Back button (click status banner to go back) ── */
if (statusBanner) {
  statusBanner.addEventListener("click", () => {
    if (appState === AppState.ACTIVE) exitDashboard();
  });
  statusBanner.style.cursor = "pointer";
}

/* ══════════════════════════════════════════════════════════════
   START BUTTON + 60-SECOND MONITOR TIMER
   ══════════════════════════════════════════════════════════════ */

const MONITOR_DURATION_MS = 15 * 1000;
let monitorTimer = null;
let monitorCountdown = null;
const startBtn = document.getElementById("startBtn");
const startTimerEl = document.getElementById("startTimer");
const startSection = document.getElementById("startSection");

function showStartButton() {
  if (startSection) startSection.style.display = "flex";
  if (startBtn) {
    startBtn.disabled = false;
    startBtn.classList.remove("running");
    const label = startBtn.querySelector(".btn-start-label");
    if (label) label.textContent = "START MONITORING";
    if (startTimerEl) startTimerEl.textContent = "";
  }
}

function hideStartButton() {
  if (startSection) startSection.style.display = "none";
}

function cancelMonitorTimer() {
  if (monitorTimer) { clearTimeout(monitorTimer); monitorTimer = null; }
  if (monitorCountdown) { clearInterval(monitorCountdown); monitorCountdown = null; }
}

function startMonitorCountdown() {
  let remaining = 15;
  if (startTimerEl) startTimerEl.textContent = remaining + "s";
  monitorCountdown = setInterval(() => {
    remaining -= 1;
    if (startTimerEl) startTimerEl.textContent = remaining + "s";
    if (remaining <= 0) {
      clearInterval(monitorCountdown);
      monitorCountdown = null;
    }
  }, 1000);
}

if (startBtn) {
  startBtn.addEventListener("click", () => {
    if (!currentStudent) return;
    if (monitorTimer) return;
    startBtn.disabled = true;
    startBtn.classList.add("running");
    const label = startBtn.querySelector(".btn-start-label");
    if (label) label.textContent = "MONITORING ACTIVE";

    /* Start thermal heatmap from MLX90640. */
    const thermalCanvas = document.getElementById("thermalCanvas");
    if (window.ThermalPanel && thermalCanvas) window.ThermalPanel.start(thermalCanvas, onThermalStressUpdate);

    beginMonitoringSession(currentStudent).then(() => {
      if (currentStudent) {
        setState(AppState.ACTIVE);
        setDebug(`SESSION ACTIVE: ${currentStudent.name}`, "green");
      }
    });

    startMonitorCountdown();

    monitorTimer = setTimeout(async () => {
      cancelMonitorTimer();
      const endedSessionId = sessionId;
      sessionActive = false;
      stopMonitoringSession();
      if (window.ThermalPanel) window.ThermalPanel.stop();
      showStartButton();

      /* Fetch and calculate session scores */
      if (endedSessionId && currentStudent) {
        const item = document.createElement("div");
        item.className = "rec-item theme-green";
        item.innerHTML = `<div class="rec-icon cyan">${ICONS.droplet}</div><div class="rec-body"><div class="rec-title">SESSION COMPLETE</div><div class="rec-desc">Calculating scores...</div></div>`;
        recList.appendChild(item);

        try {
          const summary = await window.ApiClient.getSessionSummary(endedSessionId);
          if (summary && summary.summary) {
            const naScore = scoreSodium(summary.summary.sodium ? summary.summary.sodium.avg : null);
            const lacScore = scoreLactate(summary.summary.lactate ? summary.summary.lactate.avg : null);
            const elIdx = electrolyteIndex(naScore, lacScore);
            const hydResult = calculateSessionHydration(summary.summary);

            sessionResults = {
              electrolytes: elIdx != null ? { value: elIdx, label: elIdx < 30 ? "Low" : elIdx < 70 ? "Moderate" : "Normal", theme: elIdx < 30 ? "red" : elIdx < 70 ? "amber" : "green" } : null,
              hydration: hydResult ? { value: hydResult.value, label: hydResult.label, theme: hydResult.theme } : null,
              sodiumScore: naScore,
              lactateScore: lacScore,
              electrolyteIndex: elIdx,
              summary: summary.summary,
              measurements: summary.measurements,
            };
          }

          renderSessionSummary(summary, currentStudent, sessionResults);
        } catch (e) {
          item.querySelector(".rec-desc").textContent = "Session ended. Summary unavailable.";
        }
      } else {
        sessionResults = null;
        const item = document.createElement("div");
        item.className = "rec-item theme-green";
        item.innerHTML = `<div class="rec-icon cyan">${ICONS.droplet}</div><div class="rec-body"><div class="rec-title">SESSION COMPLETE</div><div class="rec-desc">Monitoring session finished. Press START to run again.</div></div>`;
        recList.appendChild(item);
      }
      setDebug(`SESSION ENDED: ${currentStudent ? currentStudent.name : "unknown"}`, "cyan");
    }, MONITOR_DURATION_MS);
  });
}

/* ══════════════════════════════════════════════════════════════
   BOOTSTRAP
   ══════════════════════════════════════════════════════════════ */

function preventZoomGestures() {
  document.addEventListener("wheel", e => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
  for (const ev of ["gesturestart", "gesturechange", "gestureend"]) {
    document.addEventListener(ev, e => e.preventDefault());
  }
  document.addEventListener("dblclick", e => e.preventDefault(), { passive: false });
}

async function bootstrap() {
  preventZoomGestures();
  renderIdentity(null);
  setAllMetricsStandby();
  setState(AppState.SELECT);
  setDebug("SELECT A STUDENT", "cyan");
  await loadStudentPanel();
}

runBootSequence(() => { bootstrap(); });
tickClock();
