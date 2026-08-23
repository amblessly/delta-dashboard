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

  function startSession(studentId) {
    const session = {
      id: "s_" + Date.now().toString(36),
      studentId: studentId || null,
      startedTs: new Date().toISOString(),
      endedTs: null,
    };
    db.sessions.push(session);
    prune();
    save(db);
    /* Mirror to Neon (server.js -> detection_sessions). */
    apiPost("/api/sessions", { clientKey: session.id, studentName: studentId });
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
      studentName: null,
      metrics,
    });
    return sample;
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

  return { startSession, endSession, addSample, listSessions, listSamples, clearAll };
})();
