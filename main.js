"use strict";

const ICONS = {
  droplet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.7s6.5 6.6 6.5 11.3a6.5 6.5 0 1 1-13 0C5.5 9.3 12 2.7 12 2.7Z"/></svg>',
  lungs:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v8"/><path d="M9 8c-2.5 0-4.5 2-4.5 4.5V17a3 3 0 0 0 4.7 2.5L11 18v-4"/><path d="M15 8c2.5 0 4.5 2 4.5 4.5V17a3 3 0 0 1-4.7 2.5L13 18v-4"/></svg>',
  flask:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2v6L4.5 18a2.4 2.4 0 0 0 2.1 3.5h10.8a2.4 2.4 0 0 0 2.1-3.5L14 8V2"/><path d="M8 2h8"/><path d="M7 15h10"/></svg>',
  check:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/></svg>',
};

const REC_ICONS = { hydration: "droplet", stress: "lungs", lactate: "flask", electrolytes: "check" };

/* ── Boot sequence ── */
const bootMessages = ["ACQUIRING SENSOR SIGNAL\u2026", "CALIBRATING BIOMETRIC CHANNELS\u2026", "SYNCING PATIENT RECORD\u2026", "LINK ESTABLISHED"];
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
    if (i < bootMessages.length) setTimeout(step, 250);
    else setTimeout(() => { overlay.classList.add("hide"); setTimeout(() => { overlay.style.display = "none"; }, 400); if (done) done(); }, 300);
  };
  step();
  setTimeout(() => { if (overlay && overlay.style.display !== "none") { overlay.classList.add("hide"); overlay.style.display = "none"; if (done) done(); } }, 2500);
}

/* ── Rendering ── */
function renderPatient(student) {
  const nameEl = document.querySelector("[data-role=patient-name]");
  const ageEl = document.querySelector("[data-role=patient-age]");
  const weightEl = document.querySelector("[data-role=patient-weight]");
  if (!student || student.name === "--") {
    if (nameEl) nameEl.textContent = "--";
    if (ageEl) ageEl.textContent = "--";
    if (weightEl) weightEl.textContent = "--";
    return;
  }
  if (nameEl) nameEl.textContent = student.name || "--";
  if (ageEl) ageEl.textContent = (student.age != null && student.age !== "--") ? student.age : "--";
  if (weightEl) {
    const w = student.weightKg ?? student.weight_kg;
    weightEl.textContent = (w != null && w !== "--") ? Number(w).toFixed(1) : "--";
  }
}

const ASSESS_ICONS = {
  ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/></svg>',
  verify: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2.5 20h19L12 3Z"/><path d="M12 10v4"/><path d="M12 17.2v.1"/></svg>',
  critical: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7.9 2h8.2L22 7.9v8.2L16.1 22H7.9L2 16.1V7.9L7.9 2Z"/><path d="M12 8v4"/><path d="M12 16.2v.1"/></svg>',
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

function renderMetrics(snapshot) {
  for (const def of METRIC_CARDS) {
    const m = snapshot.metrics[def.key];
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

function renderHeatStress(snapshot) {
  const root = document.getElementById("card-heatstress");
  if (!root || !snapshot.heatStress) return;
  const hs = snapshot.heatStress;
  root.querySelector("[data-role=hs-pct]").textContent = hs.pct.toFixed(1);
  const pill = root.querySelector("[data-role=hs-status]");
  pill.textContent = hs.label;
  const keyByLevel = { low: "good", moderate: "slight", high: "critical" };
  pill.className = `status-pill ${statusClass(keyByLevel[hs.level])}`;
  const bar = root.querySelector("[data-role=hs-bar]");
  bar.style.width = `${Math.min(100, hs.pct)}%`;
  bar.className = `bar-fill ${hs.level === "low" ? "green" : hs.level === "moderate" ? "amber" : "red"}`;
  root.querySelector("[data-role=hs-breakdown]").textContent = `T ${hs.inputs.T} \u00B7 ELEC ${hs.inputs.E} \u00B7 LAC ${hs.inputs.L}`;
}

function renderPhStrip(snapshot) {
  const root = document.getElementById("card-phstrip");
  if (!root || !snapshot.ph) return;
  const { value, zone } = snapshot.ph;
  const PH_COLORS = { blue: "#60a5fa", greenzone: "#34d399", yellowgreen: "#a3e635", brightyellow: "#fbbf24" };
  const color = PH_COLORS[zone.id];
  root.querySelector("[data-role=ph-val]").textContent = value.toFixed(1);
  const namePill = root.querySelector("[data-role=ph-name]");
  namePill.textContent = zone.name;
  namePill.style.color = color;
  root.querySelector("[data-role=ph-range]").textContent = zone.range;
  const dot = root.querySelector("[data-role=ph-dot]");
  dot.style.background = color;
  dot.style.boxShadow = `0 0 10px ${color}`;
  const marker = root.querySelector("[data-role=ph-marker]");
  if (marker) {
    const pos = Math.min(100, Math.max(0, ((value - 3.5) / 3.3) * 100));
    marker.style.left = `${pos}%`;
    marker.style.borderColor = color;
  }
}

function statusClass(key) {
  return ({ good: "st-good", normal: "st-normal", low: "st-low", slight: "st-slight", elevated: "st-elevated", high: "st-high", critical: "st-critical", standby: "st-standby" })[key] || "st-good";
}

const STATUS_ICONS = {
  good: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/></svg>',
  normal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/></svg>',
  low: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="m6 13 6 6 6-6"/></svg>',
  slight: "",
  elevated: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2.5 20h19L12 3Z"/><path d="M12 10v4"/><path d="M12 17.2v.1"/></svg>',
  high: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6"/><path d="m15 9-6 6"/></svg>',
  critical: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7.9 2h8.2L22 7.9v8.2L16.1 22H7.9L2 16.1V7.9L7.9 2Z"/><path d="M12 8v4"/><path d="M12 16.2v.1"/></svg>',
};

function renderStatus(el, status) {
  el.className = `status-pill ${statusClass(status.key)}`;
  el.innerHTML = `${STATUS_ICONS[status.key] || ""}<span>${status.label}</span>`;
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
    case "sodium":      return clampPercent(((value - 125) / 35) * 100);
    case "lactate":     return clampPercent((value / 5) * 100);
    case "temperature": return clampPercent(((value - 36) / 2.5) * 100);
    default:            return clampPercent(value);
  }
}

function clampPercent(p) { return Math.max(2, Math.min(100, p)); }

/* ── Recommendations ── */
const recList = document.getElementById("recList");
const acknowledged = new Set();

function renderRecommendations(recs) {
  if (!recs || recs.length === 0) {
    acknowledged.clear();
    recList.innerHTML = "";
    const msg = document.createElement("div");
    msg.className = "rec-empty mono";
    msg.textContent = "NO SIGNAL \u00B7 AWAITING USER DETECTION";
    recList.appendChild(msg);
    return;
  }
  let visible = recs.filter(r => !acknowledged.has(r.id));
  if (visible.length === 0) { acknowledged.clear(); visible = recs; }
  const emptyMsg = recList.querySelector(".rec-empty");
  if (emptyMsg) emptyMsg.remove();
  [...recList.children].forEach(node => { if (!visible.some(r => r.id === node.dataset.id)) node.remove(); });
  visible.forEach((rec, idx) => {
    let node = recList.querySelector(`[data-id="${rec.id}"]`);
    if (!node) {
      node = document.createElement("div");
      node.className = `rec-item theme-${rec.theme || "green"} enter`;
      node.dataset.id = rec.id;
      node.innerHTML = `<div class="rec-icon ${rec.icon}">${ICONS[REC_ICONS[rec.id]] || ICONS.check}</div><div class="rec-body"><div class="rec-title"></div><div class="rec-desc"></div></div>`;
      node.addEventListener("click", () => { acknowledged.add(rec.id); renderRecommendations(lastSnapshot.recommendations); });
      requestAnimationFrame(() => requestAnimationFrame(() => node.classList.remove("enter")));
      recList.appendChild(node);
    }
    node.querySelector(".rec-title").textContent = rec.title;
    node.querySelector(".rec-desc").innerHTML = rec.desc;
    clearTimeout(node._rearmTimer);
    node._rearmTimer = setTimeout(() => acknowledged.delete(rec.id), 30000 + idx * 4000);
  });
}

/* ── Clock ── */
function tickClock() {
  const now = new Date();
  const pad = n => String(n).padStart(2, "0");
  document.getElementById("clock").textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}
setInterval(tickClock, 1000);

/* ── Debug status bar ── */
const debugDot = document.getElementById("debugDot");
const debugText = document.getElementById("debugText");
function setDebug(msg, color) {
  if (debugText) debugText.textContent = msg;
  if (debugDot) { debugDot.className = "debug-dot"; if (color) debugDot.classList.add(color); }
}

/* ── Touch feedback ── */
document.body.style.touchAction = "manipulation";
document.querySelectorAll(".tap").forEach(card => {
  card.addEventListener("pointerdown", () => card.classList.add("pressed"));
  ["pointerup", "pointerleave", "pointercancel"].forEach(ev => card.addEventListener(ev, () => card.classList.remove("pressed")));
});

/* ════════════════════════════════════════════════════════════════
   WIRED DATA + SCANNING
   ════════════════════════════════════════════════════════════════ */

const source = window.DashboardData.createSimulatedDataSource();
let lastSnapshot = null;
let currentStudent = null;
let scanState = "idle"; /* idle | scanning | processing | result */
let lastScanResult = null;

source.start(snapshot => {
  lastSnapshot = snapshot;
  renderPatient(snapshot.student);
  renderMetrics(snapshot);
  renderHeatStress(snapshot);
  renderPhStrip(snapshot);
  renderRecommendations(snapshot.recommendations);
  if (snapshot.presence) setDebug("ACTIVE: " + (snapshot.student?.name || "unknown"), "green");
});

/* ── Avatar ── */
const avatarBox = document.getElementById("avatarBox");
const camFeed = document.getElementById("camFeed");
function setAvatarUI({ live, scanning, detected, matched }) {
  if (!avatarBox) return;
  avatarBox.classList.toggle("live", !!live);
  avatarBox.classList.toggle("scanning", !!scanning);
  avatarBox.classList.toggle("detected", !!detected);
  avatarBox.classList.toggle("matched", !!matched);
}

/* ── Enrollment modal ── */
const enrollModal = document.getElementById("enrollModal");
const enrollNameInput = document.getElementById("enrollNameInput");
const enrollAgeInput = document.getElementById("enrollAgeInput");
const enrollWeightInput = document.getElementById("enrollWeightInput");
const enrollPhotoPreview = document.getElementById("enrollPhotoPreview");
const enrollConfirm = document.getElementById("enrollConfirm");
const enrollCancel = document.getElementById("enrollCancel");
let pendingEnrollment = null;

function showEnrollModal(enrollData) {
  pendingEnrollment = enrollData;
  enrollNameInput.value = "";
  enrollAgeInput.value = enrollData.estimatedAge || 18;
  enrollWeightInput.value = enrollData.estimatedWeight ? Number(enrollData.estimatedWeight).toFixed(1) : "54.0";
  if (enrollPhotoPreview) enrollPhotoPreview.style.display = "none";
  renderPatient({ name: "NEW STUDENT...", age: enrollData.estimatedAge || 18, weightKg: enrollData.estimatedWeight || 54.0 });
  enrollModal.style.display = "flex";
  enrollModal.setAttribute("aria-hidden", "false");
  setTimeout(() => enrollNameInput.focus(), 80);
}

function hideEnrollModal() {
  enrollModal.style.display = "none";
  enrollModal.setAttribute("aria-hidden", "true");
  pendingEnrollment = null;
}

enrollConfirm.addEventListener("click", async () => {
  const name = enrollNameInput.value.trim();
  const age = parseInt(enrollAgeInput.value, 10) || (pendingEnrollment ? pendingEnrollment.estimatedAge : 18);
  const weightKg = parseFloat(enrollWeightInput.value) || (pendingEnrollment ? pendingEnrollment.estimatedWeight : 54.0);
  if (!name) { enrollNameInput.focus(); enrollNameInput.style.borderColor = "var(--red)"; setTimeout(() => { enrollNameInput.style.borderColor = ""; }, 1500); return; }
  const { descriptor, embedding, photo } = pendingEnrollment || {};
  hideEnrollModal();
  await enrollNewStudent(name, descriptor || embedding, age, weightKg, photo);
  pendingEnrollment = null;
});

enrollCancel.addEventListener("click", () => { hideEnrollModal(); faceMonitor.resolveUnknown(null); renderPatient(null); pendingEnrollment = null; });
[enrollNameInput, enrollAgeInput, enrollWeightInput].forEach(inp => {
  inp.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); enrollConfirm.click(); } });
});

async function enrollNewStudent(name, embedding, age, weightKg, photo) {
  let result = await window.DeltaDB.enrollStudent(name, embedding, age, weightKg, photo);
  if (result) {
    faceMonitor.addKnownFace(result.id, name, embedding, age, weightKg, photo || result.photo);
    faceMonitor.resolveUnknown({ ...result, photo: photo || result.photo });
    startScanWithStudent({ ...result, photo: photo || result.photo });
  }
}

/* ── Student switching + scanning ── */
function startScanWithStudent(student) {
  currentStudent = { id: student.id ?? student.studentId, name: student.name, age: student.age, weightKg: student.weight_kg ?? student.weightKg, photo: student.photo || null };
  source.setStudent(currentStudent);
  renderPatient(currentStudent);
  setAvatarUI({ live: true, scanning: false, detected: true, matched: true });
  setDebug("SCANNING: " + currentStudent.name, "cyan");

  scanState = "scanning";
  faceScanner.startScan().then(faceData => {
    if (!faceData) { setDebug("SCAN FAILED - no face data", "red"); scanState = "idle"; return; }
    scanState = "processing";
    setDebug("ANALYZING...", "amber");
    const result = window.HealthEstimation.buildResult(faceData);
    lastScanResult = result;
    scanState = "result";
    applyScanResult(result);
  });
}

function applyScanResult(result) {
  const snapshot = {
    presence: true,
    student: currentStudent || { name: "--", age: "--", weightKg: "--" },
    metrics: result.metrics,
    heatStress: { pct: 0, level: "low", label: "N/A", inputs: { T: 0, E: 0, L: 0 } },
    ph: { value: 0, zone: { id: "blue", name: "N/A", range: "", meaning: "", action: "" } },
    assessment: { key: "ok", title: "SCAN COMPLETE", text: "AI analysis complete. Values are estimates based on facial analysis." },
    recommendations: result.recommendations,
  };
  lastSnapshot = snapshot;
  renderPatient(snapshot.student);
  renderMetrics(snapshot);
  renderRecommendations(snapshot.recommendations);
  setDebug("RESULT READY - " + currentStudent.name, "green");
}

function resetDashboard() {
  currentStudent = null;
  lastScanResult = null;
  scanState = "idle";
  source.setPresence(false);
  source.setStudent(null);
  window.DeltaDB.setActiveStudent(null);
  renderPatient(null);
  setAvatarUI({ live: true, scanning: true, detected: false, matched: false });
  setDebug("READY - LOOK AT CAMERA", "cyan");
}

/* ── Face Monitor (for enrollment flow) ── */
const faceMonitor = window.FaceMonitor.create({
  videoEl: camFeed,
  onIdentified(student) {
    if (currentStudent && currentStudent.id === (student.id ?? student.studentId)) return;
    console.log("[Main] Recognized:", student.name);
    hideGuidance();
    startScanWithStudent(student);
  },
  onUnknown(enrollData) {
    console.log("[Main] Unknown face, opening enrollment");
    setDebug("UNKNOWN -> ENROLL", "amber");
    setAvatarUI({ live: true, scanning: false, detected: true, matched: false });
    showEnrollModal(enrollData);
  },
  onNoFace() {
    hideGuidance();
    setDebug("NO FACE", "red");
    if (scanState === "scanning") { scanState = "idle"; setDebug("SCAN CANCELLED", "red"); }
    if (currentStudent) { currentStudent = null; }
    source.setPresence(false);
    source.setStudent(null);
    renderPatient(null);
    setAvatarUI({ live: true, scanning: true, detected: false, matched: false });
  },
  onUnclearFace(msg) { setDebug("UNCLEAR: " + msg, "amber"); },
  onClearFace() { setDebug("FACE OK - DETECTING", "cyan"); },
  onStatus(st) {
    if (st.state === "RUNNING") {
      setAvatarUI({ live: true, scanning: !st.models, detected: false, matched: false });
      if (st.models) { setDebug("SCANNING FOR FACES...", "cyan"); hideGuidance(); }
      else { setDebug("LOADING MODELS...", "amber"); showGuidance("Loading face recognition..."); }
    } else if (st.state === "STARTING") {
      setDebug("STARTING CAMERA...", "amber"); showGuidance("Starting camera...");
    } else if (st.state === "ERROR" || st.state === "OFF") {
      setDebug("ERROR: " + (st.error || "OFF"), "red");
      setAvatarUI({ live: false, scanning: false, detected: false, matched: false });
      currentStudent = null;
      source.setStudent(null);
      renderPatient(null);
      showGuidance(st.error || "Camera unavailable. Please allow camera access and reload.", true);
    }
  },
});

/* ── Face Scanner (for 5-second scan) ── */
const faceScanner = window.FaceScan.create({
  videoEl: camFeed,
  onScanProgress(secs) { setDebug("SCANNING... " + secs + "s", "cyan"); },
  onScanComplete(result) { if (result) setDebug("SCAN COMPLETE", "green"); },
});

/* ── Bootstrap ── */
async function bootstrap() {
  const students = await Promise.race([
    window.DeltaDB.fetchStudents(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
  ]).catch(() => []);
  if (students && students.length) faceMonitor.setKnownFaces(students);
  await faceMonitor.start();
  await faceScanner.ensureModels();
}

bootstrap();
tickClock();
runBootSequence(() => { renderPatient(null); });
