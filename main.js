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
  { key: "electrolytes", sel: "#card-electrolytes", decimals: 0 },
  { key: "hydration",    sel: "#card-hydration",    decimals: 0 },
  { key: "stress",       sel: "#card-stress",       decimals: 0 },
  { key: "sodium",       sel: "#card-sodium",       decimals: 0 },
  { key: "lactate",      sel: "#card-lactate",      decimals: 1 },
  { key: "temperature",  sel: "#card-temp",         decimals: 1 },
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
    renderCardState(root, health.metrics[def.key], def.decimals);
    if (def.key === "stress") {
      const root2 = document.querySelector(STRESS2_SEL);
      if (root2) renderCardState(root2, health.metrics[def.key], def.decimals);
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
  if (m.temperature.value != null && m.temperature.state !== "NO_SIGNAL" && m.temperature.value >= 37.8) {
    recs.push({ icon: "flask", theme: "amber", title: "Measured temperature elevated", desc: `Temperature reading of <b>${Number(m.temperature.value).toFixed(1)}\u00B0C</b> recorded (${m.temperature.source}). Consider rest and re-measurement.` });
  }
  if (m.hydration.value != null && m.hydration.state !== "NO_SIGNAL" && m.hydration.value < 60) {
    recs.push({ icon: "droplet", theme: "amber", title: "Hydration reading is low", desc: `Hydration reading of <b>${Math.round(m.hydration.value)}%</b> recorded (${m.hydration.source}). Encourage water intake.` });
  }
  if (m.stress.value != null && m.stress.state !== "NO_SIGNAL" && m.stress.value >= 70) {
    recs.push({ icon: "lungs", theme: "red", title: "Stress reading is high", desc: `Stress reading of <b>${Math.round(m.stress.value)}%</b> recorded (${m.stress.source}). Reduce activity and rest.` });
  }
  if (m.lactate.value != null && m.lactate.state !== "NO_SIGNAL" && m.lactate.value >= 4.0) {
    recs.push({ icon: "flask", theme: "amber", title: "Lactate reading elevated", desc: `Lactate reading of <b>${Number(m.lactate.value).toFixed(1)} mmol/L</b> recorded (${m.lactate.source}).` });
  }
  if (recs.length === 0) {
    const item = document.createElement("div");
    item.className = "rec-item theme-green";
    item.innerHTML = `<div class="rec-icon green">${ICONS.droplet}</div><div class="rec-body"><div class="rec-title"></div><div class="rec-desc"></div></div>`;
    item.querySelector(".rec-title").textContent = "READINGS WITHIN EXPECTED RANGES";
    item.querySelector(".rec-desc").textContent = "Based on the latest real sensor readings.";
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
    await window.ApiClient.startSession(sessionId, student.studentCode);
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
const enrollDobInput = document.getElementById("enrollDobInput");
const enrollWeightInput = document.getElementById("enrollWeightInput");
const enrollConfirmBtn = document.getElementById("enrollConfirm");
const enrollCancelBtn = document.getElementById("enrollCancel");
const enrollError = document.getElementById("enrollError");

let pendingEnrollment = null; /* { descriptor, photo } */

function showEnrollModal(capture) {
  pendingEnrollment = capture;
  enrollNameInput.value = "";
  enrollDobInput.value = "";
  enrollWeightInput.value = "";
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
  faceMonitor.resolveUnknown(null);
  setState(AppState.SCANNING);
});

[enrollNameInput, enrollDobInput, enrollWeightInput].forEach(inp => {
  inp.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); enrollConfirmBtn.click(); }
  });
});

enrollConfirmBtn.addEventListener("click", async () => {
  const name = enrollNameInput.value.trim();
  if (!name) {
    enrollError.textContent = "Please enter the student's name.";
    enrollNameInput.focus();
    return;
  }
  if (!pendingEnrollment || !pendingEnrollment.descriptor) {
    enrollError.textContent = "Face capture missing - please scan again.";
    return;
  }
  const dob = enrollDobInput.value || null;             /* date_of_birth -> age computed server-side */
  const weightRaw = enrollWeightInput.value.trim();
  let weightKg = null;
  if (weightRaw !== "") {
    const v = Number(weightRaw);
    if (!Number.isFinite(v) || v < 2 || v > 400) {
      enrollError.textContent = "Weight must be a number between 2 and 400 kg.";
      return;
    }
    weightKg = v;                                       /* validated MANUAL input - the real source */
  }

  enrollError.textContent = "";
  enrollConfirmBtn.disabled = true;
  enrollConfirmBtn.textContent = "SAVING...";

  try {
    const student = await window.ApiClient.enroll({
      name,
      descriptor: pendingEnrollment.descriptor,
      photo: pendingEnrollment.photo || undefined,
      dateOfBirth: dob || undefined,
      weightKg: weightKg === null ? undefined : weightKg,
    });
    hideEnrollModal();
    setState(AppState.LOADING, `Student ID ${student.studentCode} assigned`);
    showGuidance(`Student registered - ID ${student.studentCode}`, true);
    setTimeout(hideGuidance, 4000);
    console.log("[Main] Enrolled:", student.name, "ID", student.studentCode);
    faceMonitor.resolveUnknown(student);   /* triggers onIdentified -> dashboard */
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
  beginMonitoringSession(currentStudent).then(() => {
    if (currentStudent) {
      setState(AppState.ACTIVE);
      setDebug(`MONITORING: ${currentStudent.name} (ID ${currentStudent.studentCode})`, "green");
    }
  });
}

function exitDashboard() {
  stopMonitoringSession();
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
