"use strict";

/* main.js — Project DELTA application flow.

   POWER ON → CAMERA READY → WAITING FOR USER → FACE DETECTED →
   FACE MATCH?
     ├─ YES → STUDENT RECOGNIZED (ID) → LOAD PROFILE → LOAD HEALTH DATA → DASHBOARD
     └─ NO  → NEW STUDENT → ASK NAME (+DOB, WEIGHT) → SAVE (DB assigns ID ≥101,
              stores face reference) → DASHBOARD

   Health metrics are only ever rendered from REAL backend readings
   ({value, unit, state, recordedAt, source}). Without a reading the UI
   shows STANDBY / NO SIGNAL — values are never invented.
*/

/* ── Dashboard states ─────────────────────────────────────────── */
const AppState = {
  NO_USER: "NO_USER",
  SCANNING: "SCANNING",
  NEW_STUDENT: "NEW_STUDENT",
  LOADING: "LOADING",
  ACTIVE: "ACTIVE",
  ERROR: "ERROR",
};

let appState = AppState.NO_USER;
let currentStudent = null;      /* { studentCode, name, age, weightKg } */
let lastHealth = null;          /* latest GET /api/students/:code/health */
let healthTimer = null;
let sessionId = null;

/* ── Icons ────────────────────────────────────────────────────── */
const ICONS = {
  droplet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.7s6.5 6.6 6.5 11.3a6.5 6.5 0 1 1-13 0C5.5 9.3 12 2.7 12 2.7Z"/></svg>',
  lungs:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v8"/><path d="M9 8c-2.5 0-4.5 2-4.5 4.5V17a3 3 0 0 0 4.7 2.5L11 18v-4"/><path d="M15 8c2.5 0 4.5 2 4.5 4.5V17a3 3 0 0 1-4.7 2.5L13 18v-4"/></svg>',
  flask:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2v6L4.5 18a2.4 2.4 0 0 0 2.1 3.5h10.8a2.4 2.4 0 0 0 2.1-3.5L14 8V2"/><path d="M8 2h8"/><path d="M7 15h10"/></svg>',
};

const METRIC_CARDS = [
  { key: "heart_rate", sel: "#card-heartrate", decimals: 0 },
  { key: "hrv",        sel: "#card-hrv",       decimals: 0 },
  { key: "stress",     sel: "#card-stress",     decimals: 0 },
  { key: "breathing",  sel: "#card-breathing",  decimals: 0 },
  { key: "signal_quality", sel: "#card-signal", decimals: 0 },
];
const STRESS2_SEL = "#card-stress2";

/* ── Boot overlay ─────────────────────────────────────────────── */
const bootMessages = ["LOADING FACE DETECTION MODELS...", "INITIALIZING BIOMETRIC SCANNER...", "CONNECTING TO STUDENT DATABASE...", "SYSTEM READY"];
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
function setScannerOverlay(show) {
  if (!scannerOverlay) return;
  scannerOverlay.classList.add("active");       /* keep rendered: detection needs frames */
  scannerOverlay.classList.toggle("hide", !show);
}
function setState(state, detail) {
  appState = state;
  if (!statusBanner) return;
  const map = {
    [AppState.NO_USER]:    { cls: "",            text: "NO USER DETECTED \u00B7 Awaiting face scan..." },
    [AppState.SCANNING]:   { cls: "warn",        text: "SCANNING \u00B7 Please face the camera" },
    [AppState.NEW_STUDENT]:{ cls: "warn",        text: "NEW STUDENT DETECTED \u00B7 Please enter your name" },
    [AppState.LOADING]:    { cls: "info",        text: "LOADING STUDENT PROFILE..." },
    [AppState.ACTIVE]:     { cls: "ok",          text: "HEALTH MONITORING ACTIVE" },
    [AppState.ERROR]:      { cls: "err",         text: detail || "SYSTEM ERROR" },
  };
  const def = map[state] || { cls: "", text: "" };
  statusBanner.className = `status-banner ${def.cls}`;
  statusBanner.textContent = detail && state !== AppState.ERROR ? `${def.text} \u2014 ${detail}` : def.text;
  /* Scanner selfie-view: visible in scan/enroll states, hidden on dashboard.
     Exception: the transient "STARTING CAMERA..." error keeps it visible to
     avoid a flash-hide-flash cycle during onboarding. */
  const transientCam = state === AppState.ERROR && String(detail || "").includes("STARTING CAMERA");
  setScannerOverlay(!((state === AppState.ACTIVE || state === AppState.ERROR) && !transientCam));
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

/* ── Avatar UI ────────────────────────────────────────────────── */
const avatarBox = document.getElementById("avatarBox");
function setAvatarUI({ live, scanning, detected, matched }) {
  if (!avatarBox) return;
  avatarBox.classList.toggle("live", !!live);
  avatarBox.classList.toggle("scanning", !!scanning);
  avatarBox.classList.toggle("detected", !!detected);
  avatarBox.classList.toggle("matched", !!matched);
}

/* ══════════════════════════════════════════════════════════════
   IDENTITY PANEL — profile data comes ONLY from the database
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
  /* Age: computed by the backend from date_of_birth. Never guessed here. */
  if (a) a.textContent = age != null ? age : "--";
  /* Weight: profile value entered during registration (or future scale). */
  if (w) w.textContent = student.weightKg != null ? Number(student.weightKg).toFixed(1) : "--";
}

/* ══════════════════════════════════════════════════════════════
   METRIC CARDS — explicit data states, never fake numbers
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
    if (def.key === "stress") {
      const root2 = document.querySelector(STRESS2_SEL);
      if (root2) {
        renderCardState(root2, { value: null, state: "NO_SIGNAL" }, def.decimals);
        const st2 = root2.querySelector("[data-role=status]");
        if (st2) {
          st2.className = `status-pill ${statusClass("standby")}`;
          st2.innerHTML = `<span>STANDBY</span>`;
        }
      }
    }
  }
}

function renderHealth(health) {
  if (!health || !health.metrics) return;
  for (const def of METRIC_CARDS) {
    const root = document.querySelector(def.sel);
    if (!root) continue;
    let metric = health.metrics[def.key];
    /* signal_quality is computed client-side by rPPG, never stored in DB. */
    if (def.key === "signal_quality") {
      metric = signalQualityLocal != null
        ? { value: signalQualityLocal, state: signalQualityLocal >= 50 ? "GOOD" : "LOW", unit: "%", source: "rppg" }
        : { value: null, state: "NO_SIGNAL", unit: "%", source: "" };
    }
    renderCardState(root, metric, def.decimals);
    if (def.key === "stress") {
      const root2 = document.querySelector(STRESS2_SEL);
      if (root2) renderCardState(root2, metric, def.decimals);
    }
  }
}

/* ══════════════════════════════════════════════════════════════
   RECOMMENDATIONS — derived ONLY from real readings
   ══════════════════════════════════════════════════════════════ */

const recList = document.getElementById("recList");

function renderRecommendationsFromHealth(health) {
  recList.innerHTML = "";
  const hasRealData = health && health.metrics &&
    Object.values(health.metrics).some(m => m.value != null && m.state !== "NO_SIGNAL");

  if (!hasRealData) {
    const item = document.createElement("div");
    item.className = "rec-item theme-green";
    item.innerHTML = `<div class="rec-icon cyan">${ICONS.droplet}</div><div class="rec-body"><div class="rec-title"></div><div class="rec-desc"></div></div>`;
    item.querySelector(".rec-title").textContent = "AWAITING VALID HEALTH DATA";
    item.querySelector(".rec-desc").textContent = "No sensor signal yet. Recommendations will appear once real measurements arrive.";
    recList.appendChild(item);
    return;
  }

  /* Conservative notes based strictly on measured values. */
  const recs = [];
  const m = health.metrics;

  if (m.heart_rate && m.heart_rate.value != null && m.heart_rate.state !== "NO_SIGNAL" && m.heart_rate.value >= 110) {
    recs.push({ icon: "lungs", theme: "amber", title: "Heart rate is elevated", desc: `Heart rate of <b>${Math.round(m.heart_rate.value)} bpm</b> recorded (${m.heart_rate.source}). Consider rest and monitoring.` });
  }
  if (m.heart_rate && m.heart_rate.value != null && m.heart_rate.state !== "NO_SIGNAL" && m.heart_rate.value < 45) {
    recs.push({ icon: "lungs", theme: "amber", title: "Heart rate is unusually low", desc: `Heart rate of <b>${Math.round(m.heart_rate.value)} bpm</b> recorded (${m.heart_rate.source}). Verify sensor contact.` });
  }
  if (m.hrv && m.hrv.value != null && m.hrv.state !== "NO_SIGNAL" && m.hrv.value < 20) {
    recs.push({ icon: "lungs", theme: "red", title: "HRV very low — possible stress", desc: `HRV of <b>${Math.round(m.hrv.value)} ms</b> recorded (${m.hrv.source}). Low HRV can indicate elevated stress.` });
  }
  if (m.stress && m.stress.value != null && m.stress.state !== "NO_SIGNAL" && m.stress.value >= 70) {
    recs.push({ icon: "lungs", theme: "red", title: "Stress reading is high", desc: `Stress reading of <b>${Math.round(m.stress.value)}%</b> recorded (${m.stress.source}). Reduce activity and rest.` });
  }
  if (m.breathing && m.breathing.value != null && m.breathing.state !== "NO_SIGNAL" && m.breathing.value >= 25) {
    recs.push({ icon: "lungs", theme: "amber", title: "Respiration rate elevated", desc: `Breathing rate of <b>${Math.round(m.breathing.value)}/min</b> recorded (${m.breathing.source}). May indicate exertion or anxiety.` });
  }
  if (m.temperature && m.temperature.value != null && m.temperature.state !== "NO_SIGNAL" && m.temperature.value >= 37.8) {
    recs.push({ icon: "flask", theme: "amber", title: "Temperature elevated", desc: `Temperature reading of <b>${Number(m.temperature.value).toFixed(1)}\u00B0C</b> recorded (${m.temperature.source}). Consider rest and re-measurement.` });
  }
  if (recs.length === 0) {
    const item = document.createElement("div");
    item.className = "rec-item theme-green";
    item.innerHTML = `<div class="rec-icon green">${ICONS.droplet}</div><div class="rec-body"><div class="rec-title"></div><div class="rec-desc"></div></div>`;
    item.querySelector(".rec-title").textContent = "READINGS WITHIN EXPECTED RANGES";
    item.querySelector(".rec-desc").textContent = "Based on the latest rPPG vital signs.";
    recList.appendChild(item);
    return;
  }
  for (const rec of recs.slice(0, 3)) {
    const node = document.createElement("div");
    node.className = `rec-item theme-${rec.theme}`;
    node.innerHTML = `<div class="rec-icon ${rec.icon}">${ICONS[rec.icon]}</div><div class="rec-body"><div class="rec-title"></div><div class="rec-desc"></div></div>`;
    node.querySelector(".rec-title").textContent = rec.title;
    node.querySelector(".rec-desc").innerHTML = rec.desc;
    recList.appendChild(node);
  }
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
    renderRecommendationsFromHealth(health);
    /* Merge any fresher weight into the identity panel. */
    if (health.student && health.student.weightKg != null) {
      currentStudent.weightKg = health.student.weightKg;
      renderIdentity(currentStudent);
    }
  } catch (e) {
    console.warn("[Main] health fetch failed:", e.message);
  }
}

/* ══════════════════════════════════════════════════════════════
   ENROLLMENT MODAL (new student flow)
   ══════════════════════════════════════════════════════════════ */

const enrollModal = document.getElementById("enrollModal");
const enrollNameInput = document.getElementById("enrollNameInput");
const enrollConfirmBtn = document.getElementById("enrollConfirm");
const enrollCancelBtn = document.getElementById("enrollCancel");
const enrollError = document.getElementById("enrollError");

let pendingEnrollment = null; /* { descriptor, photo } */
let manualEnroll = false;     /* true when registering without a face scan */

function showEnrollModal(capture) {
  pendingEnrollment = capture;   /* may be null in manual registration mode */
  enrollNameInput.value = "";
  enrollError.textContent = "";
  enrollConfirmBtn.disabled = false;
  enrollConfirmBtn.textContent = "SAVE STUDENT";
  enrollModal.style.display = "flex";
  enrollModal.setAttribute("aria-hidden", "false");
  setState(AppState.NEW_STUDENT);
  setDebug("NEW STUDENT - ENTER NAME", "amber");
  setTimeout(() => enrollNameInput.focus(), 80);
}

function hideEnrollModal() {
  enrollModal.style.display = "none";
  enrollModal.setAttribute("aria-hidden", "true");
  pendingEnrollment = null;
}

enrollCancelBtn.addEventListener("click", () => {
  hideEnrollModal();
  if (manualEnroll) {
    manualEnroll = false;
    setState(AppState.NO_USER);
  } else {
    faceMonitor.resolveUnknown(null);
    setState(AppState.SCANNING);
  }
});

/* ── Manual access: skip the face scan, open the dashboard directly ── */
const manualAccessBtn = document.getElementById("manualAccessBtn");
let manualPanel = null;

function closeManualPanel() {
  if (manualPanel) { manualPanel.remove(); manualPanel = null; }
}

async function withRetry(fn, attempts) {
  let lastErr;
  for (let i = 0; i < (attempts || 3); i++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      if (e.status && e.status < 500) throw e;   /* client errors: no retry */
      await new Promise(r => setTimeout(r, 1200));
    }
  }
  throw lastErr;
}

manualAccessBtn.addEventListener("click", async () => {
  try {
    const students = await withRetry(() => window.ApiClient.listStudents(), 4);
    openManualPanel(Array.isArray(students) ? students : []);
  } catch (e) {
    showGuidance("Cannot reach server - cannot list students.", true);
  }
});

function openManualPanel(students) {
  closeManualPanel();
  manualPanel = document.createElement("div");
  manualPanel.className = "manual-panel";
  const h = document.createElement("h3");
  h.textContent = "MANUAL ACCESS";
  manualPanel.appendChild(h);

  if (students.length === 0) {
    const empty = document.createElement("div");
    empty.className = "manual-empty mono";
    empty.textContent = "No registered students yet.";
    manualPanel.appendChild(empty);
  } else {
    for (const s of students) {
      const b = document.createElement("button");
      b.className = "manual-item";
      b.type = "button";
      b.textContent = `ID ${s.studentCode} — ${s.name}`;
      b.addEventListener("click", () => { closeManualPanel(); enterDashboard(s); });
      manualPanel.appendChild(b);
    }
  }

  const actions = document.createElement("div");
  actions.className = "manual-actions";

  const reg = document.createElement("button");
  reg.className = "btn-manual";
  reg.textContent = "+ NEW STUDENT";
  reg.addEventListener("click", () => {
    closeManualPanel();
    manualEnroll = true;
    showEnrollModal(null);
  });

  const cancel = document.createElement("button");
  cancel.className = "btn-manual";
  cancel.textContent = "CANCEL";
  cancel.addEventListener("click", closeManualPanel);

  actions.appendChild(reg);
  actions.appendChild(cancel);
  manualPanel.appendChild(actions);

  const box = scannerOverlay.querySelector(".scanner-box");
  (box || scannerOverlay).appendChild(manualPanel);
}

enrollNameInput.addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); enrollConfirmBtn.click(); }
});

enrollConfirmBtn.addEventListener("click", async () => {
  const name = enrollNameInput.value.trim();
  if (!name) {
    enrollError.textContent = "Please enter the student's name.";
    enrollNameInput.focus();
    return;
  }
  if (!manualEnroll && (!pendingEnrollment || !pendingEnrollment.descriptor)) {
    enrollError.textContent = "Face capture missing - please scan again.";
    return;
  }
  /* Name-only registration: age/weight are not collected at enrollment. */
  enrollError.textContent = "";
  enrollConfirmBtn.disabled = true;
  enrollConfirmBtn.textContent = "SAVING...";

  try {
    const payload = { name };
    if (!manualEnroll) {
      payload.descriptor = pendingEnrollment.descriptor;
      payload.photo = pendingEnrollment.photo || undefined;
    }
    const student = await window.ApiClient.enroll(payload);
    const wasManual = manualEnroll;
    manualEnroll = false;
    hideEnrollModal();
    setState(AppState.LOADING, `Student ID ${student.studentCode} assigned`);
    showGuidance(`Student registered - ID ${student.studentCode}`, true);
    setTimeout(hideGuidance, 4000);
    console.log("[Main] Enrolled:", student.name, "ID", student.studentCode);
    if (wasManual) enterDashboard(student);
    else faceMonitor.resolveUnknown(student);   /* triggers onIdentified -> dashboard */
  } catch (e) {
    if (e.status === 409 && e.data && e.data.student) {
      /* Face already registered -> resolve to the EXISTING student. */
      hideEnrollModal();
      showGuidance(`This face is already registered as ${e.data.student.name} (ID ${e.data.student.studentCode})`, true);
      setTimeout(hideGuidance, 4000);
      faceMonitor.resolveUnknown(e.data.student);
    } else if (e.message === "BACKEND_UNAVAILABLE") {
      enrollConfirmBtn.disabled = false;
      enrollConfirmBtn.textContent = "SAVE STUDENT";
      enrollError.textContent = "Cannot reach the server. Check your connection and try again.";
    } else {
      enrollConfirmBtn.disabled = false;
      enrollConfirmBtn.textContent = "SAVE STUDENT";
      enrollError.textContent = e.message || "Registration failed. Please try again.";
    }
  }
});

/* ══════════════════════════════════════════════════════════════
   FACE MONITOR WIRING
   ══════════════════════════════════════════════════════════════ */

function enterDashboard(student) {
  currentStudent = student;
  renderIdentity(currentStudent);
  setAvatarUI({ live: true, scanning: false, detected: true, matched: true });
  setAllMetricsStandby();                 /* reset sensors until fresh data arrives */
  setState(AppState.LOADING);
  /* Start rPPG engine: live vital signs from face video. */
  window.RPPG.start(camFeedVideo);
  beginMonitoringSession(currentStudent).then(() => {
    if (currentStudent) {
      setState(AppState.ACTIVE);
      setDebug(`MONITORING: ${currentStudent.name} (ID ${currentStudent.studentCode})`, "green");
      startVitalsPostLoop();
    }
  });
}

function exitDashboard() {
  stopMonitoringSession();
  stopVitalsPostLoop();
  window.RPPG.stop();
  currentStudent = null;
  lastHealth = null;
  renderIdentity(null);
  setAllMetricsStandby();
  recList.innerHTML = "";
  const empty = document.createElement("div");
  empty.className = "rec-empty mono";
  empty.textContent = "NO SIGNAL \u00B7 AWAITING USER DETECTION";
  recList.appendChild(empty);
  setState(AppState.NO_USER);
  setAvatarUI({ live: true, scanning: true, detected: false, matched: false });
  setDebug("READY - LOOK AT CAMERA", "cyan");
}

/* ══════════════════════════════════════════════════════════════
   rPPG VITALS — POST computed readings to the server + draw waveform
   ══════════════════════════════════════════════════════════════ */
let vitalsPostTimer = null;
let signalQualityLocal = null;   /* injected into renderHealth for frontend-only metric */
const VITALS_POST_MS = 6000;

function startVitalsPostLoop() {
  stopVitalsPostLoop();
  vitalsPostTimer = setInterval(postRppgVitals, VITALS_POST_MS);
  drawWaveformLoop();   /* starts its own rAF loop */
}
function stopVitalsPostLoop() {
  if (vitalsPostTimer) { clearInterval(vitalsPostTimer); vitalsPostTimer = null; }
}

async function postRppgVitals() {
  if (!currentStudent || !sessionId) return;
  const v = window.RPPG.getVitals();
  if (!v || v.bpm == null) return;
  const metrics = {
    stress: v.stressPct != null ? Math.round(v.stressPct) : undefined,
  };
  if (v.bpm >= 30 && v.bpm <= 220) metrics.heart_rate = v.bpm;
  if (v.rmssd != null && v.rmssd >= 5 && v.rmssd <= 400) metrics.hrv = Math.round(v.rmssd);
  if (v.breathPerMin != null && v.breathPerMin >= 4 && v.breathPerMin <= 45) metrics.breathing = v.breathPerMin;
  signalQualityLocal = Math.round(v.confidence * 100);
  try {
    await window.ApiClient.postMeasurements({
      studentCode: currentStudent.studentCode,
      sessionClientKey: sessionId,
      source: "webcam_rppg",
      metrics,
    });
  } catch (e) { /* non-critical */ }
}

/* ── Waveform canvas ── */
const rppgCanvas = document.getElementById("rppgCanvas");
const rppgCtx = rppgCanvas ? rppgCanvas.getContext("2d") : null;
let rafId = null;
function drawWaveformLoop() {
  if (!rppgCtx) return;
  function frame() {
    if (!vitalsPostTimer) return;  /* stopped */
    drawWaveform();
    drawHeatmap();
    rafId = requestAnimationFrame(frame);
  }
  rafId = requestAnimationFrame(frame);
}

function drawWaveform() {
  if (!rppgCtx) return;
  const W = rppgCanvas.width, H = rppgCanvas.height;
  rppgCtx.clearRect(0, 0, W, H);
  const sig = window.RPPG.getSignal();
  if (sig.length < 10) {
    rppgCtx.fillStyle = "rgba(34,211,238,0.25)";
    rppgCtx.font = "11px 'Cascadia Mono', monospace";
    rppgCtx.fillText("AWAITING RPPG SIGNAL\u2026", 12, H / 2 + 4);
    return;
  }
  const tMin = sig[0].t, tMax = sig[sig.length - 1].t;
  const dur = Math.max(tMax - tMin, 1);
  const vals = sig.map(s => s.g);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const rng = Math.max(hi - lo, 0.1);
  rppgCtx.beginPath();
  rppgCtx.strokeStyle = "rgba(34,211,238,0.9)";
  rppgCtx.lineWidth = 1.6;
  rppgCtx.shadowColor = "#22d3ee";
  rppgCtx.shadowBlur = 4;
  for (let i = 0; i < sig.length; i++) {
    const x = ((sig[i].t - tMin) / dur) * W;
    const y = H - 6 - ((vals[i] - lo) / rng) * (H - 14);
    i === 0 ? rppgCtx.moveTo(x, y) : rppgCtx.lineTo(x, y);
  }
  rppgCtx.stroke();
  rppgCtx.shadowBlur = 0;
}

/* ── Heatmap strip: 10 cells showing confidence over recent windows ── */
const hmEl = document.getElementById("rppgHeatmap");
let hmCells = null;
function drawHeatmap() {
  if (!hmEl) return;
  if (!hmCells) {
    hmEl.innerHTML = "";
    hmCells = [];
    for (let i = 0; i < 10; i++) {
      const c = document.createElement("div");
      c.className = "hm-cell";
      hmEl.appendChild(c);
      hmCells.push(c);
    }
  }
  const v = window.RPPG.getVitals();
  const sig = window.RPPG.getSignal();
  if (!v || v.bpm == null) {
    hmCells.forEach(c => c.style.background = "rgba(34,211,238,0.08)");
    return;
  }
  /* shift cells left, push current confidence colour */
  for (let i = 0; i < hmCells.length - 1; i++) {
    hmCells[i].style.background = hmCells[i + 1].style.background;
  }
  const conf = v.confidence;
  const hue = conf > 0.6 ? 170 : conf > 0.3 ? 45 : 0;   /* green / amber / red */
  hmCells[hmCells.length - 1].style.background =
    `hsla(${hue}, 80%, 50%, ${0.25 + conf * 0.65})`;
}

const camFeedVideo = document.getElementById("camFeed");

const faceMonitor = window.FaceMonitor.create({
  videoEl: camFeedVideo,

  onIdentified(student) {
    if (currentStudent && currentStudent.studentCode === student.studentCode) return;
    hideGuidance();
    setState(AppState.LOADING);
    enterDashboard(student);
  },

  onUnknown(capture) {
    setAvatarUI({ live: true, scanning: false, detected: true, matched: false });
    showEnrollModal(capture);
  },

  onNoFace() {
    if (appState === AppState.NEW_STUDENT) return; /* modal open - keep waiting */
    exitDashboard();
  },

  onGuidance(msg) {
    if (!msg) { if (appState !== AppState.ERROR) hideGuidance(); return; }
    if (appState === AppState.NEW_STUDENT) return;
    showGuidance(msg);
  },

  onStatus(st) {
    if (st.state === "RUNNING") {
      if (st.models) {
        setDebug(st.dbg || "SCANNING FOR FACES...", "cyan");
        hideGuidance();
        if (appState === AppState.ERROR) setState(AppState.NO_USER);
      } else {
        setDebug("LOADING MODELS...", "amber");
        showGuidance("Loading face recognition models...");
      }
    } else if (st.state === "STARTING") {
      setState(AppState.ERROR, "STARTING CAMERA...");
      showGuidance("Starting camera...");
    } else if (st.state === "ERROR") {
      setState(AppState.ERROR, st.error || "CAMERA UNAVAILABLE");
      showGuidance(st.error || "Unable to access camera.", true);
      setDebug("ERROR: " + (st.error || "camera"), "red");
    } else if (st.state === "OFF") {
      setDebug("CAMERA OFF", "red");
    }
  },
});

/* ══════════════════════════════════════════════════════════════
   BOOTSTRAP
   ══════════════════════════════════════════════════════════════ */

async function bootstrap() {
  renderIdentity(null);
  setAllMetricsStandby();
  setState(AppState.NO_USER);

  console.log("[Main] Starting camera...");
  const started = await faceMonitor.start();
  if (!started) {
    /* onStatus already reported the precise error */
    setDebug("CAMERA FAILED", "red");
    return;
  }
  setAvatarUI({ live: true, scanning: true, detected: false, matched: false });
  setState(AppState.NO_USER);
  setDebug("SCANNING FOR FACES...", "cyan");
}

runBootSequence(() => { bootstrap(); });
tickClock();
