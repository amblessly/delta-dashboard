"use strict";

/* api-client.js — single browser gateway to the Project DELTA backend.
   Identity data comes from the backend; health values are only ever
   displayed when the backend reports a real reading with source+time. */

window.ApiClient = (function () {

  const DEFAULT_TIMEOUT = 8000;

  async function request(pathname, options) {
    const opts = Object.assign({ headers: {} }, options || {});
    if (opts.body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(opts.body);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeout || DEFAULT_TIMEOUT);
    let res;
    try {
      res = await fetch(pathname, { ...opts, signal: controller.signal });
    } catch (e) {
      throw new Error("BACKEND_UNAVAILABLE");
    } finally {
      clearTimeout(timer);
    }
    let data = null;
    try { data = await res.json(); } catch (e) { /* non-JSON */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || ("HTTP " + res.status));
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  /* POST /api/face/match */
  function matchFace(descriptor) {
    return request("/api/face/match", { method: "POST", body: { descriptor }, timeout: 6000 });
  }

  /* POST /api/students/enroll → resolves with { studentCode, name, age, ... } */
  function enroll(payload) {
    return request("/api/students/enroll", {
      method: "POST",
      body: payload,
      timeout: 12000,
    });
  }

  /* GET /api/students/:code */
  function getProfile(studentCode) {
    return request(`/api/students/${encodeURIComponent(studentCode)}`);
  }

  /* GET /api/students/:code/health
     → { student, metrics: { hydration: { value, unit, state, recordedAt, source }, ... } } */
  function getHealth(studentCode) {
    return request(`/api/students/${encodeURIComponent(studentCode)}/health`);
  }

  /* Monitoring session binding sensor data to one student. */
  function startSession(clientKey, studentCode) {
    return request("/api/sessions", { method: "POST", body: { clientKey, studentCode } });
  }

  function endSession(clientKey) {
    return request("/api/sessions/end", { method: "POST", body: { clientKey } });
  }

  return { matchFace, enroll, getProfile, getHealth, startSession, endSession };
})();
