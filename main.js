/* --------------------
   main.js - UI binding for the Project DELTA health dashboard.
   Consumes snapshots from a DataSource (see data.js) and renders.
   -------------------- */

"use strict";

const ICONS = {
  droplet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.7s6.5 6.6 6.5 11.3a6.5 6.5 0 1 1-13 0C5.5 9.3 12 2.7 12 2.7Z"/></svg>',
  lungs:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v8"/><path d="M9 8c-2.5 0-4.5 2-4.5 4.5V17a3 3 0 0 0 4.7 2.5L11 18v-4"/><path d="M15 8c2.5 0 4.5 2 4.5 4.5V17a3 3 0 0 1-4.7 2.5L13 18v-4"/></svg>',
  flask:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2v6L4.5 18a2.4 2.4 0 0 0 2.1 3.5h10.8a2.4 2.4 0 0 0 2.1-3.5L14 8V2"/><path d="M8 2h8"/><path d="M7 15h10"/></svg>',
  check:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/></svg>',
};

const REC_ICONS = {
  hydration: "droplet",
  stress: "lungs",
  lactate: "flask",
  electrolytes: "check",
};

/* - Boot sequence -------------------- */

const bootMessages = [
  "ACQUIRING SENSOR SIGNAL\u2026",
  "CALIBRATING BIOMETRIC CHANNELS\u2026",
  "SYNCING PATIENT RECORD\u2026",
  "LINK ESTABLISHED",
];

function runBootSequence(done) {
  const overlay = document.getElementById("bootOverlay");
  const status = document.getElementById("bootStatus");
  const bar = document.getElementById("bootBar");

  let i = 0;
  const step = () => {
    status.textContent = bootMessages[i];
    bar.style.width = `${Math.round(((i + 1) / bootMessages.length) * 100)}%`;
    i += 1;
    if (i < bootMessages.length) {
      setTimeout(step, 450);
    } else {
      setTimeout(() => {
        overlay.classList.add("hide");
        done();
      }, 500);
    }
  };
  step();
}

/* - Rendering -------------------- */

function renderPatient(student) {
  if (!student) return;
  const nameEl = document.querySelector("[data-role=patient-name]");
  const ageEl = document.querySelector("[data-role=patient-age]");
  const weightEl = document.querySelector("[data-role=patient-weight]");
  if (nameEl) nameEl.textContent = student.name;
  if (ageEl) ageEl.textContent = student.age;
  if (weightEl) weightEl.textContent = Number(student.weightKg).toFixed(1);
}

/* Measurement-verification note under the recommendations.
   Communicates reassessment guidance without claiming a diagnosis. */
const ASSESS_ICONS = {
  ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/></svg>',
  verify: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2.5 20h19L12 3Z"/><path d="M12 10v4"/><path d="M12 17.2v.1"/></svg>',
  critical: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7.9 2h8.2L22 7.9v8.2L16.1 22H7.9L2 16.1V7.9L7.9 2Z"/><path d="M12 8v4"/><path d="M12 16.2v.1"/></svg>',
};

function renderAssessment(assessment) {
  const root = document.getElementById("assessNote");
  if (!root || !assessment) return;
  root.dataset.key = assessment.key;
  const icEl = root.querySelector("[data-role=assess-ic]");
  icEl.innerHTML = ASSESS_ICONS[assessment.key] || ASSESS_ICONS.ok;
  root.querySelector("[data-role=assess-title]").textContent = assessment.title;
  root.querySelector("[data-role=assess-text]").textContent = assessment.text;
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

function renderMetrics(snapshot) {
  for (const def of METRIC_CARDS) {
    const m = snapshot.metrics[def.key];
    const root = document.querySelector(def.sel);
    if (!root) continue;

    const valEl = root.querySelector("[data-role=value]");
    const stEl = root.querySelector("[data-role=status]");
    const barEl = root.querySelector("[data-role=bar]");

    const text = Number(m.value).toFixed(def.decimals);
    valEl.textContent = text;
    renderStatus(stEl, m.status);
    barEl.style.width = `${barPercent(def.key, m.value)}%`;
    barEl.className = `bar-fill ${barClassFor(def.key, m.status.key)}`;

    /* mirror stress into the secondary-row card */
    if (def.key === "stress") {
      const root2 = document.querySelector(STRESS2_SEL);
      if (root2) {
        root2.querySelector("[data-role=value]").textContent = text;
        renderStatus(root2.querySelector("[data-role=status]"), m.status);
        const bar2 = root2.querySelector("[data-role=bar]");
        bar2.style.width = `${barPercent("stress", m.value)}%`;
        bar2.className = `bar-fill ${barClassFor("stress", m.status.key)}`;
      }
    }
  }
}

/* Heat Stress % card: formula output + normalized inputs readout */
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
  bar.className = `bar-fill ${
    hs.level === "low" ? "green" : hs.level === "moderate" ? "amber" : "red"
  }`;

  root.querySelector("[data-role=hs-breakdown]").textContent =
    `T ${hs.inputs.T} \u00B7 ELEC ${hs.inputs.E} \u00B7 LAC ${hs.inputs.L}`;
}

const PH_COLORS = {
  blue: "#60a5fa",
  greenzone: "#34d399",
  yellowgreen: "#a3e635",
  brightyellow: "#fbbf24",
};

function renderPhStrip(snapshot) {
  const root = document.getElementById("card-phstrip");
  if (!root || !snapshot.ph) return;
  const { value, zone } = snapshot.ph;
  const color = PH_COLORS[zone.id];

  root.querySelector("[data-role=ph-val]").textContent = value.toFixed(1);
  const namePill = root.querySelector("[data-role=ph-name]");
  namePill.textContent = zone.name;
  namePill.style.color = color;
  root.querySelector("[data-role=ph-range]").textContent = zone.range;

  const dot = root.querySelector("[data-role=ph-dot]");
  dot.style.background = color;
  dot.style.boxShadow = `0 0 10px ${color}`;

  /* position the marker on the BCG gradient strip (bar spans pH 3.5 - 6.8) */
  const marker = root.querySelector("[data-role=ph-marker]");
  if (marker) {
    const pos = Math.min(100, Math.max(0, ((value - 3.5) / 3.3) * 100));
    marker.style.left = `${pos}%`;
    marker.style.borderColor = color;
  }
}

function statusClass(key) {
  return ({
    good: "st-good",
    normal: "st-normal",
    low: "st-low",
    slight: "st-slight",
    elevated: "st-elevated",
    high: "st-high",
    critical: "st-critical",
    standby: "st-standby",
  })[key] || "st-good";
}

/* Tiny glyphs shown beside each status label */
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
    hydration:    { good: "teal", low: "amber", critical: "red" },
    stress:       { normal: "purple", slight: "purple", high: "purple", critical: "red" },
    sodium:       { normal: "cyan", elevated: "orange", critical: "red" },
    lactate:      { normal: "green", elevated: "amber", critical: "red" },
    temperature:  { normal: "teal", slight: "orange", critical: "red" },
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

function clampPercent(p) {
  return Math.max(2, Math.min(100, p));
}

/* - Recommendations rendering -------------------- */

const recList = document.getElementById("recList");
const acknowledged = new Set();

function renderRecommendations(recs) {
  /* No face detected -> NO SIGNAL placeholder instead of recommendations. */
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
  if (visible.length === 0) {
    acknowledged.clear();
    visible = recs;
  }

  const emptyMsg = recList.querySelector(".rec-empty");
  if (emptyMsg) emptyMsg.remove();

  // remove stale nodes
  [...recList.children].forEach(node => {
    if (!visible.some(r => r.id === node.dataset.id)) node.remove();
  });

  visible.forEach((rec, idx) => {
    let node = recList.querySelector(`[data-id="${rec.id}"]`);
    if (!node) {
      node = document.createElement("div");
      node.className = `rec-item theme-${rec.theme || "green"} enter`;
      node.dataset.id = rec.id;
      node.innerHTML = `
        <div class="rec-icon ${rec.icon}">${ICONS[REC_ICONS[rec.id]] || ICONS.check}</div>
        <div class="rec-body">
          <div class="rec-title"></div>
          <div class="rec-desc"></div>
        </div>`;
      node.addEventListener("click", () => {
        acknowledged.add(rec.id);
        applyRecAction(rec.id);
        renderRecommendations(lastSnapshot.recommendations);
      });
      requestAnimationFrame(() => requestAnimationFrame(() =>
        node.classList.remove("enter")));
      recList.appendChild(node);
    }
    node.querySelector(".rec-title").textContent = rec.title;
    node.querySelector(".rec-desc").innerHTML = rec.desc;

    // keep acknowledged items cycling back after a while
    clearTimeout(node._rearmTimer);
    node._rearmTimer = setTimeout(() => acknowledged.delete(rec.id), 30000 + idx * 4000);
  });
}

function applyRecAction(id) {
  if (id === "hydration" || id === "electrolytes") source.sendCommand({ type: "hydrate" });
  if (id === "stress") source.sendCommand({ type: "breathe" });
}

/* - Clock -------------------- */

function tickClock() {
  const now = new Date();
  const pad = n => String(n).padStart(2, "0");
  document.getElementById("clock").textContent =
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}
setInterval(tickClock, 1000);

/* - Touch press feedback on cards -------------------- */
document.body.style.touchAction = "manipulation";
document.querySelectorAll(".tap").forEach(card => {
  card.addEventListener("pointerdown", () => card.classList.add("pressed"));
  ["pointerup", "pointerleave", "pointercancel"].forEach(ev =>
    card.addEventListener(ev, () => card.classList.remove("pressed")));
});

/* - Wiring: data source + face recognition + database -------------------- */

const source = window.DashboardData.createSimulatedDataSource();

let lastSnapshot = null;

/* Current student context (drives data source + DB session). */
let currentStudent = null;

source.start(snapshot => {
  lastSnapshot = snapshot;
  renderPatient(snapshot.student);
  renderMetrics(snapshot);
  renderRecommendations(snapshot.recommendations);
});

/* ── Enrollment modal ── */

const enrollModal = document.getElementById("enrollModal");
const enrollNameInput = document.getElementById("enrollNameInput");
const enrollConfirm = document.getElementById("enrollConfirm");
const enrollCancel = document.getElementById("enrollCancel");
let pendingDescriptor = null;

function showEnrollModal(descriptor) {
  pendingDescriptor = descriptor;
  enrollNameInput.value = "";
  enrollModal.style.display = "flex";
  enrollModal.setAttribute("aria-hidden", "false");
  setTimeout(() => enrollNameInput.focus(), 50);
}

function hideEnrollModal() {
  enrollModal.style.display = "none";
  enrollModal.setAttribute("aria-hidden", "true");
  pendingDescriptor = null;
}

enrollConfirm.addEventListener("click", async () => {
  const name = enrollNameInput.value.trim();
  if (!name) return;
  hideEnrollModal();
  await enrollNewStudent(name, pendingDescriptor);
  pendingDescriptor = null;
});

enrollCancel.addEventListener("click", () => {
  hideEnrollModal();
  faceMonitor.resolveUnknown(null);
  pendingDescriptor = null;
});

async function enrollNewStudent(name, descriptor) {
  const result = await window.DeltaDB.enrollStudent(name, descriptor);
  if (!result) return;
  /* Add to face monitor for instant recognition without reload. */
  faceMonitor.addKnownFace(result.id, name, descriptor);
  /* Switch to this student immediately. */
  await switchStudent(result);
}

/* Switch the whole dashboard context to a student. */
async function switchStudent(student) {
  currentStudent = { id: student.id, name: student.name };
  source.setPresence(true);                 /* show readings */
  window.DeltaDB.setActiveStudent(currentStudent);
  endCurrentSession();
  dbSessionId = window.DeltaDB.startSession(currentStudent);
  dbPushSample();
  dbSampleTimer = setInterval(dbPushSample, 10000);
}

function dbPushSample() {
  if (!lastSnapshot || !currentStudent || !lastSnapshot.metrics) return;
  const m = lastSnapshot.metrics;
  window.DeltaDB.addSample(dbSessionId, {
    electrolytes: m.electrolytes.value,
    hydration: m.hydration.value,
    stress: m.stress.value,
    sodium: m.sodium.value,
    lactate: m.lactate.value,
    temperature: m.temperature.value,
  });
}

let dbSessionId = null;
let dbSampleTimer = null;

function endCurrentSession() {
  if (dbSampleTimer) { clearInterval(dbSampleTimer); dbSampleTimer = null; }
  if (dbSessionId) { window.DeltaDB.endSession(dbSessionId); dbSessionId = null; }
}

/* ── Avatar camera + face recognition ── */

const avatarBox = document.getElementById("avatarBox");
const camFeed = document.getElementById("camFeed");

function setAvatarUI({ live, scanning, detected, matched }) {
  if (!avatarBox) return;
  avatarBox.classList.toggle("live", !!live);
  avatarBox.classList.toggle("scanning", !!scanning);
  avatarBox.classList.toggle("detected", !!detected);
  avatarBox.classList.toggle("matched", !!matched);
}

/* ── Load enrolled students into face monitor ── */

async function bootstrapFaceMonitor() {
  const students = await window.DeltaDB.fetchStudents();
  if (students && students.length) {
    faceMonitor.setKnownFaces(students);
  }
  /* Start camera + recognition loop. */
  faceMonitor.start();
}

/* ── Start face recognition ── */

const faceMonitor = window.FaceMonitor.create({
  videoEl: camFeed,

  onIdentified(student) {
    /* Known student recognized. */
    if (currentStudent && currentStudent.id === student.id) return;
    currentStudent = { ...student };
    source.setPresence(true);
    window.DeltaDB.setActiveStudent(currentStudent);
    setAvatarUI({ live: true, scanning: false, detected: true, matched: true });
    /* (Re)start DB session for this student. */
    endCurrentSession();
    dbSessionId = window.DeltaDB.startSession(currentStudent);
    dbPushSample();
    dbSampleTimer = setInterval(dbPushSample, 10000);
  },

  onUnknown(descriptor) {
    /* Unknown face → enrollment modal. */
    setAvatarUI({ live: true, scanning: false, detected: true, matched: false });
    showEnrollModal(descriptor);
  },

  onNoFace() {
    /* No face at all. */
    if (!currentStudent) return;
    endCurrentSession();
    currentStudent = null;
    source.setPresence(false);
    window.DeltaDB.setActiveStudent(null);
    setAvatarUI({ live: true, scanning: true, detected: false, matched: false });
  },

  onStatus(st) {
    if (st.state === "RUNNING") {
      setAvatarUI({ live: true, scanning: !st.models, detected: false, matched: false });
    } else if (st.state === "ERROR" || st.state === "OFF") {
      setAvatarUI({ live: false, scanning: false, detected: false, matched: false });
      endCurrentSession();
      currentStudent = null;
      source.setPresence(false);
      window.DeltaDB.setActiveStudent(null);
    }
  },
});

/* Init: load students → start camera/face recognition. */
bootstrapFaceMonitor();

tickClock();
runBootSequence(() => {
  /* dashboard is already rendering beneath the overlay; nothing else needed */
});
