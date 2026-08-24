/* --------------------
   db.js - Measurement database.

   Dual-write storage:
   1. Neon PostgreSQL via the dashboard server API (/api/*) whenever the
      app is served by health-dashboard/server/server.js.
   2. localStorage fallback (always written too, so the dashboard keeps
      working offline or from file:// where the API is unavailable).

   Records:
     sessions - one per face-detection period (start/end timestamps)
     samples  - periodic readings while a user is detected

   API: window.DeltaDB.startSession / endSession / addSample /
        listSessions / listSamples / clearAll
   -------------------- */

"use strict";

window.DeltaDB = (function () {

  const LS_DB = "delta.db.v1";
  const SAMPLE_LIMIT = 300;
  const SESSION_LIMIT = 50;

  /* Fire-and-forget POST to the Neon-backed API (server.js).
     Silently ignored when the page is not served by the server. */
  function apiPost(pathname, body) {
    try {
      fetch(pathname, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        keepalive: true,
      }).catch(() => {});
    } catch (e) { /* fetch unavailable -> local-only mode */ }
  }

  function load() {
    try {
      const raw = localStorage.getItem(LS_DB);
      if (raw) {
        const d = JSON.parse(raw);
        if (d && Array.isArray(d.sessions) && Array.isArray(d.samples)) return d;
      }
    } catch (e) { /* corrupted -> reset */ }
    return { sessions: [], samples: [] };
  }

  function save(db) {
    try { localStorage.setItem(LS_DB, JSON.stringify(db)); }
    catch (e) { console.warn("[DeltaDB] persist failed:", e); }
  }

  let db = load();

  function prune() {
    if (db.samples.length > SAMPLE_LIMIT) {
      db.samples = db.samples.slice(-SAMPLE_LIMIT);
    }
    if (db.sessions.length > SESSION_LIMIT) {
      db.sessions = db.sessions.slice(-SESSION_LIMIT);
    }
  }

  /* ── Sessions ──────────────────────────────────────────────────── */

  /* Current student context for session/sample mirroring.
     Set by main.js whenever a face is identified/enrolled. */
  let activeStudent = null;
  function setActiveStudent(s) { activeStudent = s ? { id: s.id ?? null, name: s.name ?? null } : null; }

  function startSession(student) {
    if (student !== undefined && student !== null && typeof student === "object") {
      setActiveStudent(student);
    }
    const session = {
      id: "s_" + Date.now().toString(36),
      studentId: activeStudent ? activeStudent.id : null,
      startedTs: new Date().toISOString(),
      endedTs: null,
    };
    db.sessions.push(session);
    prune();
    save(db);
    /* Mirror to Neon (server.js -> detection_sessions). */
    apiPost("/api/sessions", {
      clientKey: session.id,
      studentId: activeStudent ? activeStudent.id : null,
      studentName: activeStudent ? activeStudent.name : null,
    });
    return session.id;
  }

  function endSession(sessionId) {
    const s = db.sessions.find(x => x.id === sessionId);
    if (s) {
      s.endedTs = new Date().toISOString();
      save(db);
      apiPost("/api/sessions/end", { clientKey: sessionId });
    }
  }

  /* ── Samples ───────────────────────────────────────────────────── */

  function addSample(sessionId, metrics) {
    const sample = {
      ts: new Date().toISOString(),
      sessionId: sessionId || null,
      electrolytes: Math.round(metrics.electrolytes ?? 0),
      hydration: Math.round(metrics.hydration ?? 0),
      stress: Math.round(metrics.stress ?? 0),
      sodium: Math.round(metrics.sodium ?? 0),
      lactate: Number((metrics.lactate ?? 0).toFixed(2)),
      temperature: Number((metrics.temperature ?? 0).toFixed(2)),
    };
    db.samples.push(sample);
    prune();
    save(db);
    /* Mirror to Neon (server.js -> measurements). */
    apiPost("/api/measurements", {
      sessionClientKey: sessionId,
      studentId: activeStudent ? activeStudent.id : null,
      studentName: activeStudent ? activeStudent.name : null,
      metrics,
    });
    return sample;
  }

  /* ── Students & face embeddings (recognition registry) ────────── */

  const LS_STUDENTS = "delta.students.v1";

  function loadKnownStudents() {
    try {
      const raw = localStorage.getItem(LS_STUDENTS);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) return arr;
      }
    } catch (e) { /* corrupted -> reset */ }
    return [];
  }

  function saveKnownStudents(list) {
    try { localStorage.setItem(LS_STUDENTS, JSON.stringify(list)); }
    catch (e) { console.warn("[DeltaDB] students persist failed:", e); }
  }

  /* Bootstrap matcher from server; falls back to local cache offline. */
  async function fetchStudents() {
    try {
      const r = await fetch("/api/students");
      if (!r.ok) throw new Error("HTTP " + r.status);
      const list = await r.json();
      saveKnownStudents(list);
      return list;
    } catch (e) {
      return loadKnownStudents();   /* offline: last synced cache */
    }
  }

  async function enrollStudent(name, embedding, age, weightKg, photo) {
    const payload = { name, embedding, age, weightKg };
    try {
      const r = await fetch("/api/students/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const saved = await r.json();
      const list = loadKnownStudents();
      list.push({ ...saved, photo: photo || null, embeddings: [embedding] });
      saveKnownStudents(list);
      return { ...saved, photo: photo || null };
    } catch (e) {
      /* Offline enrollment: keep locally so recognition still works;
         server row will be missing until re-enrolled. */
      const local = {
        id: -Date.now(),
        name,
        age: age || null,
        weight_kg: weightKg || null,
        photo: photo || null,
        embeddings: [embedding],
        localOnly: true,
      };
      const list = loadKnownStudents();
      list.push(local);
      saveKnownStudents(list);
      return local;
    }
  }

  function clearStudents() {
    try { localStorage.removeItem(LS_STUDENTS); } catch (e) {}
  }

  function listSessions() { return [...db.sessions].reverse(); }
  function listSamples(limit) {
    const arr = [...db.samples].reverse();
    return limit ? arr.slice(0, limit) : arr;
  }
  function clearAll() {
    db = { sessions: [], samples: [] };
    save(db);
  }

  return {
    startSession, endSession, addSample, setActiveStudent,
    fetchStudents, enrollStudent, clearStudents,
    listSessions, listSamples, clearAll
  };
})();
