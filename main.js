"use strict";

/* ════════════════════════════════════════════════════════════════
   Project DELTA — Main Application
   Onboarding → Scanner → Detect → Analyze → Dashboard → Save/Load
   ════════════════════════════════════════════════════════════════ */

const STORAGE_KEY = "delta_profiles_v1";

/* ── Icons ── */
const ICONS = {
  droplet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.7s6.5 6.6 6.5 11.3a6.5 6.5 0 1 1-13 0C5.5 9.3 12 2.7 12 2.7Z"/></svg>',
  lungs:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v8"/><path d="M9 8c-2.5 0-4.5 2-4.5 4.5V17a3 3 0 0 0 4.7 2.5L11 18v-4"/><path d="M15 8c2.5 0 4.5 2 4.5 4.5V17a3 3 0 0 1-4.7 2.5L13 18v-4"/></svg>',
  flask:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2v6L4.5 18a2.4 2.4 0 0 0 2.1 3.5h10.8a2.4 2.4 0 0 0 2.1-3.5L14 8V2"/><path d="M8 2h8"/><path d="M7 15h10"/></svg>',
  check:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/></svg>',
};
const REC_ICONS = { hydration: "droplet", stress: "lungs", lactate: "flask", electrolytes: "check" };

/* ── Boot sequence ── */
const bootMessages = ["LOADING FACE DETECTION MODELS...", "INITIALIZING BIOMETRIC SCANNER...", "CALIBRATING HEALTH ANALYSIS...", "SYSTEM READY"];

function runBootSequence(done) {
  const overlay = document.getElementById("bootOverlay");
  const status = document.getElementById("bootStatus");
  const bar = document.getElementById("bootBar");
  if (!overlay) { if (done) done(); return; }
  let i = 0;
  const step = () => {
    if (status && bootMessages[i]) status.textContent = bootMessages[i];
    if (bar) bar.style.width = `${Math.round(((i + 1) / bootMessages.length) * 100)}%`;
    i += 1;
    if (i < bootMessages.length) setTimeout(step, 400);
    else setTimeout(() => { overlay.classList.add("hide"); setTimeout(() => { overlay.style.display = "none"; if (done) done(); }, 500); }, 400);
  };
  step();
  setTimeout(() => { if (overlay && overlay.style.display !== "none") { overlay.classList.add("hide"); overlay.style.display = "none"; if (done) done(); } }, 4000);
}

/* ── Rendering helpers ── */
function renderPatient(student) {
  const n = document.querySelector("[data-role=patient-name]");
  const a = document.querySelector("[data-role=patient-age]");
  const w = document.querySelector("[data-role=patient-weight]");
  if (!student || !student.name || student.name === "--") {
    if (n) n.textContent = "--";
    if (a) a.textContent = "--";
    if (w) w.textContent = "--";
    return;
  }
  if (n) n.textContent = student.name;
  if (a) a.textContent = student.age != null ? student.age : "--";
  if (w) w.textContent = student.weight != null ? student.weight : "--";
}

const METRIC_CARDS = [
  { key: "electrolytes", sel: "#card-electrolytes", decimals: 0 },
  { key: "hydration",    sel: "#card-hydration",    decimals: 0 },
  { key: "stress",       sel: "#card-stress",       decimals: 0 },
  { key: "sodium",       sel: "#card-sodium",       decimals: 0 },
  { key: "lactate",      sel: "#card-lactate",      decimals: 1 },
  { key: "temperature",  sel: "#card-temp",         decimals: 1 },
];
const STRESS2_SEL = "#card-stress2";

function statusClass(key) {
  return ({ good: "st-good", normal: "st-normal", low: "st-low", slight: "st-slight", elevated: "st-elevated", high: "st-high", critical: "st-critical", standby: "st-standby" })[key] || "st-good";
}

const STATUS_ICONS = {
  good: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/></svg>',
  normal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/></svg>',
  low: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14"/><path d="m6 13 6 6 6-6"/></svg>',
  slight: "",
  elevated: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 3 2.5 20h19L12 3Z"/><path d="M12 10v4"/><path d="M12 17.2v.1"/></svg>',
  high: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6"/><path d="m15 9-6 6"/></svg>',
  critical: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M7.9 2h8.2L22 7.9v8.2L16.1 22H7.9L2 16.1V7.9L7.9 2Z"/><path d="M12 8v4"/><path d="M12 16.2v.1"/></svg>',
};

function renderStatus(el, st) {
  el.className = `status-pill ${statusClass(st.key)}`;
  el.innerHTML = `${STATUS_ICONS[st.key] || ""}<span>${st.label}</span>`;
}

function barClassFor(metricKey, statusKey) {
  if (statusKey === "standby") return "dim";
  const map = {
    electrolytes: { good: "green", low: "amber", critical: "red" },
    hydration: { good: "teal", low: "amber", critical: "red" },
    stress: { normal: "purple", slight: "purple", high: "purple", critical: "red" },
    sodium: { normal: "cyan", elevated: "orange", critical: "red" },
    lactate: { normal: "green", elevated: "amber", critical: "red" },
    temperature: { normal: "teal", slight: "orange", critical: "red" },
  };
  return (map[metricKey] || {})[statusKey] || "cyan";
}

function barPercent(key, value) {
  switch (key) {
    case "sodium":      return clamp(((value - 125) / 35) * 100, 2, 100);
    case "lactate":     return clamp((value / 5) * 100, 2, 100);
    case "temperature": return clamp(((value - 36) / 2.5) * 100, 2, 100);
    default:            return clamp(value, 2, 100);
  }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function renderMetrics(result) {
  if (!result) return;
  for (const def of METRIC_CARDS) {
    const m = result.metrics[def.key];
    const root = document.querySelector(def.sel);
    if (!root) continue;
    root.querySelector("[data-role=value]").textContent = Number(m.value).toFixed(def.decimals);
    renderStatus(root.querySelector("[data-role=status]"), m.status);
    const barEl = root.querySelector("[data-role=bar]");
    barEl.style.width = `${barPercent(def.key, m.value)}%`;
    barEl.className = `bar-fill ${barClassFor(def.key, m.status.key)}`;
    if (def.key === "stress") {
      const root2 = document.querySelector(STRESS2_SEL);
      if (root2) {
        root2.querySelector("[data-role=value]").textContent = Number(m.value).toFixed(def.decimals);
        renderStatus(root2.querySelector("[data-role=status]"), m.status);
        const bar2 = root2.querySelector("[data-role=bar]");
        bar2.style.width = `${barPercent("stress", m.value)}%`;
        bar2.className = `bar-fill ${barClassFor("stress", m.status.key)}`;
      }
    }
  }
}

/* ── Recommendations ── */
const recList = document.getElementById("recList");

function renderRecommendations(recs) {
  recList.innerHTML = "";
  if (!recs || recs.length === 0) {
    const msg = document.createElement("div");
    msg.className = "rec-empty mono";
    msg.textContent = "NO SIGNAL \u00B7 AWAITING USER DETECTION";
    recList.appendChild(msg);
    return;
  }
  recs.forEach(rec => {
    const node = document.createElement("div");
    node.className = `rec-item theme-${rec.theme || "green"} enter`;
    node.innerHTML = `<div class="rec-icon ${rec.icon}">${ICONS[REC_ICONS[rec.id]] || ICONS.check}</div><div class="rec-body"><div class="rec-title"></div><div class="rec-desc"></div></div>`;
    node.querySelector(".rec-title").textContent = rec.title;
    node.querySelector(".rec-desc").innerHTML = rec.desc;
    requestAnimationFrame(() => requestAnimationFrame(() => node.classList.remove("enter")));
    recList.appendChild(node);
  });
}

/* ── Reset dashboard to standby ── */
function resetDashboard() {
  renderPatient(null);
  for (const def of METRIC_CARDS) {
    const root = document.querySelector(def.sel);
    if (!root) continue;
    root.querySelector("[data-role=value]").textContent = "--";
    renderStatus(root.querySelector("[data-role=status]"), { key: "standby", label: "STANDBY" });
    root.querySelector("[data-role=bar]").style.width = "0%";
    root.querySelector("[data-role=bar]").className = "bar-fill dim";
    if (def.key === "stress") {
      const root2 = document.querySelector(STRESS2_SEL);
      if (root2) {
        root2.querySelector("[data-role=value]").textContent = "--";
        renderStatus(root2.querySelector("[data-role=status]"), { key: "standby", label: "STANDBY" });
        root2.querySelector("[data-role=bar]").style.width = "0%";
        root2.querySelector("[data-role=bar]").className = "bar-fill dim";
      }
    }
  }
  renderRecommendations(null);
}

/* ── Clock ── */
function tickClock() {
  const now = new Date();
  const pad = n => String(n).padStart(2, "0");
  document.getElementById("clock").textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}
setInterval(tickClock, 1000);

/* ── Debug bar ── */
const debugDot = document.getElementById("debugDot");
const debugText = document.getElementById("debugText");
function setDebug(msg, color) {
  if (debugText) debugText.textContent = msg;
  if (debugDot) { debugDot.className = "debug-dot"; if (color) debugDot.classList.add(color); }
}

/* ── Avatar UI ── */
const avatarBox = document.getElementById("avatarBox");
function setAvatarUI({ live, scanning, detected, matched }) {
  if (!avatarBox) return;
  avatarBox.classList.toggle("live", !!live);
  avatarBox.classList.toggle("scanning", !!scanning);
  avatarBox.classList.toggle("detected", !!detected);
  avatarBox.classList.toggle("matched", !!matched);
}

/* ── Guidance toast ── */
const guidanceToast = document.getElementById("guidanceToast");
const guidanceText = document.getElementById("guidanceText");
let guidanceTimer = null;
function showGuidance(msg, persistent) {
  if (!guidanceToast) return;
  if (guidanceText) guidanceText.textContent = msg;
  guidanceToast.style.display = "flex";
  clearTimeout(guidanceTimer);
  if (!persistent) guidanceTimer = setTimeout(() => { if (guidanceToast) guidanceToast.style.display = "none"; }, 3000);
}
function hideGuidance() {
  if (guidanceToast) guidanceToast.style.display = "none";
  clearTimeout(guidanceTimer);
}

/* ════════════════════════════════════════════════════════════════
   PROFILE STORAGE (localStorage)
   ════════════════════════════════════════════════════════════════ */

function loadProfiles() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) { return []; }
}

function saveProfiles(profiles) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles)); }
  catch (e) { console.warn("[Storage] save failed:", e); }
}

function saveProfile(profile) {
  const profiles = loadProfiles();
  const idx = profiles.findIndex(p => p.id === profile.id);
  if (idx >= 0) profiles[idx] = profile;
  else profiles.push(profile);
  saveProfiles(profiles);
}

function getProfileById(id) {
  return loadProfiles().find(p => p.id === id) || null;
}

/* ════════════════════════════════════════════════════════════════
   APPLICATION STATE
   ════════════════════════════════════════════════════════════════ */

let currentProfile = null;   /* currently displayed user profile */
let currentResult = null;    /* current health estimation result */
let lastDescriptor = null;   /* last captured face descriptor */

/* ── DOM refs ── */
const scannerOverlay = document.getElementById("scannerOverlay");
const scannerStatus = document.getElementById("scannerStatus");
const scannerHint = document.getElementById("scannerHint");
const scannerCam = document.getElementById("scannerCam");
const camFeed = document.getElementById("camFeed");
const nameInput = document.getElementById("studentNameInput");
const saveBtn = document.getElementById("saveBtn");
const saveHint = document.getElementById("saveHint");

/* ════════════════════════════════════════════════════════════════
   SCANNER FLOW
   ════════════════════════════════════════════════════════════════ */

function showScanner() {
  scannerOverlay.classList.add("active");
  scannerOverlay.classList.remove("detected");
  scannerOverlay.classList.add("scanning");
  scannerStatus.textContent = "LOOK AT CAMERA";
  scannerHint.textContent = "Position your face inside the frame";
}

function hideScanner() {
  scannerOverlay.classList.add("hide");
  setTimeout(() => scannerOverlay.classList.remove("active", "hide", "scanning", "detected"), 500);
}

function scannerDetected(userName) {
  scannerOverlay.classList.remove("scanning");
  scannerOverlay.classList.add("detected");
  scannerStatus.textContent = userName ? `WELCOME BACK, ${userName.toUpperCase()}` : "FACE CAPTURED";
  scannerHint.textContent = "Analyzing health signals...";
}

/* ════════════════════════════════════════════════════════════════
   FACE DETECTION → ANALYSIS → DASHBOARD
   ════════════════════════════════════════════════════════════════ */

let processing = false;

function onFaceDetected(descriptor, match) {
  if (processing) return;
  processing = true;
  lastDescriptor = descriptor;

  /* Show scanner detection */
  const existingProfile = match && match.matched ? match.profile : null;
  scannerDetected(existingProfile ? existingProfile.name : null);

  /* Generate health result from face descriptor */
  const result = window.HealthEstimation.buildResult(descriptor);
  currentResult = result;

  /* Use existing profile or create new */
  if (existingProfile) {
    currentProfile = existingProfile;
    console.log("[Main] Returning user:", existingProfile.name);
    setDebug("RECOGNIZED: " + existingProfile.name, "green");
  } else {
    currentProfile = {
      id: "user_" + result.seed,
      name: "--",
      descriptor: descriptor,
      age: result.age,
      weight: result.weight,
      createdAt: new Date().toISOString(),
    };
    console.log("[Main] New user detected");
    setDebug("NEW USER - ENTER NAME", "amber");
  }

  /* Update avatar */
  setAvatarUI({ live: true, scanning: false, detected: true, matched: !!existingProfile });

  /* Update patient info */
  renderPatient({ name: currentProfile.name, age: result.age, weight: result.weight });

  /* Update metrics */
  renderMetrics(result);

  /* Update recommendations */
  renderRecommendations(result.recommendations);

  /* Update save section */
  if (existingProfile) {
    nameInput.value = existingProfile.name;
    nameInput.disabled = true;
    saveBtn.textContent = "SCANNING";
    saveBtn.disabled = true;
    saveHint.textContent = `Welcome back, ${existingProfile.name}!`;
    saveHint.className = "save-hint mono success";
  } else {
    nameInput.value = "";
    nameInput.disabled = false;
    saveBtn.textContent = "SAVE DATA";
    saveBtn.disabled = false;
    saveHint.textContent = "Enter your name and save your profile";
    saveHint.className = "save-hint mono";
  }

  /* Hide scanner after short delay */
  setTimeout(hideScanner, existingProfile ? 800 : 1200);

  /* Re-enable detection after a cooldown */
  setTimeout(() => { processing = false; }, existingProfile ? 2000 : 3000);
}

function onFaceLost() {
  setDebug("NO FACE - LOOK AT CAMERA", "red");
  setAvatarUI({ live: true, scanning: true, detected: false, matched: false });
}

/* ════════════════════════════════════════════════════════════════
   SAVE / NEW SCAN
   ════════════════════════════════════════════════════════════════ */

saveBtn.addEventListener("click", () => {
  const name = nameInput.value.trim();
  if (!name) { nameInput.focus(); nameInput.style.borderColor = "var(--red)"; setTimeout(() => { nameInput.style.borderColor = ""; }, 1500); return; }
  if (!currentProfile || !lastDescriptor) return;

  currentProfile.name = name;
  currentProfile.descriptor = lastDescriptor;
  currentProfile.age = currentResult ? currentResult.age : currentProfile.age;
  currentProfile.weight = currentResult ? currentResult.weight : currentProfile.weight;
  currentProfile.updatedAt = new Date().toISOString();

  saveProfile(currentProfile);
  faceMonitor.addKnownFace(currentProfile);

  renderPatient({ name: name, age: currentProfile.age, weight: currentProfile.weight });
  setAvatarUI({ live: true, scanning: false, detected: true, matched: true });
  setDebug("SAVED: " + name, "green");

  saveHint.textContent = `Profile saved! ${name} is now recognized.`;
  saveHint.className = "save-hint mono success";
  nameInput.disabled = true;
  saveBtn.textContent = "SAVED";
  saveBtn.disabled = true;

  console.log("[Main] Profile saved:", name);
});

nameInput.addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); saveBtn.click(); }
});

/* ── New scan button (press Enter on name input when disabled) ── */
nameInput.addEventListener("focus", () => {
  if (nameInput.disabled) {
    /* Start new scan */
    currentProfile = null;
    currentResult = null;
    lastDescriptor = null;
    processing = false;
    resetDashboard();
    nameInput.value = "";
    nameInput.disabled = false;
    saveBtn.textContent = "SAVE DATA";
    saveBtn.disabled = false;
    saveHint.textContent = "Enter your name and save your profile";
    saveHint.className = "save-hint mono";
    setAvatarUI({ live: true, scanning: true, detected: false, matched: false });
    setDebug("READY - LOOK AT CAMERA", "cyan");
    showScanner();
  }
});

/* ════════════════════════════════════════════════════════════════
   FACE MONITOR SETUP
   ════════════════════════════════════════════════════════════════ */

const camFeedVideo = document.getElementById("camFeed");

const faceMonitor = window.FaceMonitor.create({
  videoEl: camFeedVideo,
  onFaceDetected(descriptor, match) {
    onFaceDetected(descriptor, match);
  },
  onNoFace() {
    onFaceLost();
  },
  onStatus(st) {
    if (st.state === "RUNNING") {
      if (st.models) {
        setDebug("READY - LOOK AT CAMERA", "cyan");
        hideGuidance();
      } else {
        setDebug("LOADING MODELS...", "amber");
        showGuidance("Loading face recognition models...");
      }
    } else if (st.state === "STARTING") {
      setDebug("STARTING CAMERA...", "amber");
      showGuidance("Starting camera...");
    } else if (st.state === "ERROR" || st.state === "OFF") {
      setDebug("ERROR: " + (st.error || "OFF"), "red");
      showGuidance(st.error || "Camera unavailable.", true);
    }
  },
});

/* ════════════════════════════════════════════════════════════════
   BOOTSTRAP
   ════════════════════════════════════════════════════════════════ */

async function bootstrap() {
  /* Load saved profiles into face monitor */
  const profiles = loadProfiles();
  faceMonitor.setKnownFaces(profiles);
  console.log("[Main] Loaded", profiles.length, "saved profiles");

  /* Start camera + models */
  console.log("[Main] Starting camera...");
  const started = await faceMonitor.start();
  if (!started) {
    setDebug("CAMERA FAILED", "red");
    showGuidance("Camera failed. Check permissions and reload.", true);
    return;
  }

  /* Show scanner overlay */
  showScanner();
  setDebug("SCANNING FOR FACES...", "cyan");
}

/* ── Start everything ── */
runBootSequence(() => {
  resetDashboard();
  bootstrap();
});
tickClock();
