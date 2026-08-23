/* --------------------
   calibration.js - Color reference dataset + measurement log.

   The calibration dataset starts EMPTY on purpose. Per project rules,
   no RGB calibration values are invented: the operator enters real
   measured points from known-pH strips/solutions via the Calibration UI
   or by importing a shared dataset. Until then, the system reports
   NOT CALIBRATED and the analysis layer falls back to a clearly-labelled
   uncalibrated hue estimate with capped confidence.

   Persistence: browser localStorage (no backend exists in this project).
   Keys are versioned so future schema changes do not corrupt old data.
   -------------------- */

"use strict";

window.StripCalibration = (function () {

  const LS_POINTS = "delta.strip.calibration.v1";
  const LS_HISTORY = "delta.strip.measurements.v1";
  const HISTORY_LIMIT = 50;

  function load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      const data = JSON.parse(raw);
      return Array.isArray(data) ? data : fallback;
    } catch (e) {
      console.warn("[StripCalibration] Could not read stored data:", e);
      return fallback;
    }
  }

  function save(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      console.warn("[StripCalibration] Could not persist data:", e);
      return false;
    }
  }

  let points = load(LS_POINTS, []);
  let history = load(LS_HISTORY, []);
  const listeners = [];

  function emit() { listeners.forEach(fn => fn()); }
  function subscribe(fn) { listeners.push(fn); }

  /* ── Validation ──────────────────────────────────────────────────── */

  function validRGB(rgb) {
    return !!rgb &&
      Number.isFinite(rgb.r) && Number.isFinite(rgb.g) && Number.isFinite(rgb.b) &&
      rgb.r >= 0 && rgb.r <= 255 && rgb.g >= 0 && rgb.g <= 255 && rgb.b >= 0 && rgb.b <= 255;
  }

  function validPH(ph) {
    return Number.isFinite(ph) && ph >= 0 && ph <= 14;
  }

  /* ── Calibration points ──────────────────────────────────────────── */

  function addPoint(ph, rgb, label) {
    if (!validPH(ph)) return { ok: false, error: "pH must be a number between 0 and 14." };
    if (!validRGB(rgb)) return { ok: false, error: "Invalid RGB values." };
    const point = {
      id: "cp_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      ph: Math.round(ph * 10) / 10,
      r: Math.round(rgb.r), g: Math.round(rgb.g), b: Math.round(rgb.b),
      label: typeof label === "string" && label.trim() ? label.trim() : null,
      ts: new Date().toISOString(),
    };
    points.push(point);
    save(LS_POINTS, points);
    emit();
    return { ok: true, point };
  }

  function removePoint(id) {
    const before = points.length;
    points = points.filter(p => p.id !== id);
    save(LS_POINTS, points);
    emit();
    return points.length < before;
  }

  function clearPoints() {
    points = [];
    save(LS_POINTS, points);
    emit();
  }

  function listPoints() { return [...points]; }
  function count() { return points.length; }

  /* At least two points are required before nearest-reference matching
     is considered calibrated. */
  function isCalibrated() { return points.length >= 2; }

  function stateLabel() {
    if (points.length === 0) return "NOT CALIBRATED";
    if (points.length === 1) return "1 POINT - INSUFFICIENT";
    return `CALIBRATED \u00B7 ${points.length} PTS`;
  }

  function exportJSON() {
    return JSON.stringify({
      version: 1,
      exportedAt: new Date().toISOString(),
      note: "Project DELTA BCG strip calibration points. Values must come from measured known-pH references.",
      points,
    }, null, 2);
  }

  function importJSON(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return { ok: false, error: "File is not valid JSON." };
    }
    const incoming = Array.isArray(data) ? data : data.points;
    if (!Array.isArray(incoming)) {
      return { ok: false, error: "No calibration points array found in file." };
    }
    let added = 0, skipped = 0;
    for (const p of incoming) {
      const res = addPoint(Number(p.ph), { r: p.r, g: p.g, b: p.b }, p.label || "imported");
      if (res.ok) added++; else skipped++;
    }
    return { ok: added > 0, added, skipped };
  }

  /* ── Measurement history ─────────────────────────────────────────── */

  function recordMeasurement(m) {
    const entry = {
      ts: m.ts || new Date().toISOString(),
      ph: Number.isFinite(m.ph) ? Math.round(m.ph * 100) / 100 : null,
      zoneId: m.zoneId || null,
      zoneName: m.zoneName || null,
      r: validRGB(m.rgb) ? Math.round(m.rgb.r) : null,
      g: validRGB(m.rgb) ? Math.round(m.rgb.g) : null,
      b: validRGB(m.rgb) ? Math.round(m.rgb.b) : null,
      confidence: Number.isFinite(m.confidence) ? Math.round(m.confidence) : null,
      method: m.method || null,
      status: m.status || "OK",
    };
    history.unshift(entry);
    if (history.length > HISTORY_LIMIT) history.length = HISTORY_LIMIT;
    save(LS_HISTORY, history);
    emit();
    return entry;
  }

  function listMeasurements() { return [...history]; }
  function clearMeasurements() { history = []; save(LS_HISTORY, history); emit(); }

  return {
    addPoint, removePoint, clearPoints, listPoints, count,
    isCalibrated, stateLabel, exportJSON, importJSON,
    recordMeasurement, listMeasurements, clearMeasurements,
    subscribe,
    _validRGB: validRGB, _validPH: validPH,
  };
})();
