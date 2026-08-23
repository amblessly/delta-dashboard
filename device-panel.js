/* --------------------
   device-panel.js - UI wiring for Device Monitor, Strip Analysis,
   Calibration, and Measurement Log panels.

   Connects the physical-device abstraction (device.js) and the
   processing layers (strip-analysis.js, calibration.js) to the DOM,
   and pushes validated measurements into the dashboard data source.
   -------------------- */

"use strict";

window.StripPanel = (function () {

  function init({ source, getSnapshot }) {
    const $ = id => document.getElementById(id);
    const els = {
      modeTag: $("devModeTag"), camera: $("devCamera"), lighting: $("devLighting"),
      strip: $("devStrip"), sensors: $("devSensors"), btnLight: $("btnLight"),
      proc: $("stripProc"), view: $("stripView"), video: $("camVideo"),
      btnCam: $("btnCam"), btnCapture: $("btnCapture"), btnRecapture: $("btnRecapture"),
      roiX: $("roiX"), roiY: $("roiY"), roiW: $("roiW"), roiH: $("roiH"),
      msg: $("stripMsg"), result: $("stripResult"),
      swatch: $("resSwatch"), ph: $("resPH"), zone: $("resZone"),
      rgb: $("resRGB"), method: $("resMethod"),
      confFill: $("confFill"), confPct: $("resConf"),
      calibState: $("calibState"), calibList: $("calibList"),
      calibPh: $("calibPh"), btnCalSave: $("btnCalSave"),
      btnCalExport: $("btnCalExport"), btnCalImportBtn: $("btnCalImportBtn"),
      calibFile: $("calibFile"), btnCalClear: $("btnCalClear"),
      histBody: $("histBody"), histEmpty: $("histEmpty"), btnHistClear: $("btnHistClear"),
    };

    /* ── Device manager ─────────────────────────────────────────── */

    const device = StripDevice.createManager({
      viewCanvas: els.view,
      videoEl: els.video,
      getSimulatedPH: () => {
        const snap = getSnapshot();
        return snap ? snap.ph.value : 6.0;
      },
      onStatus: renderDeviceStatus,
      onProcessing: setProcessing,
      onResult: handleResult,
    });

    /* ── Device monitor rendering ───────────────────────────────── */

    function renderDeviceStatus(st) {
      els.modeTag.textContent = st.mode === "LIVE_CAMERA" ? "LIVE CAMERA" : "SIMULATION";
      els.modeTag.dataset.key = st.mode === "LIVE_CAMERA" ? "live" : "sim";
      els.camera.textContent = st.camera;
      setPill(els.camera, st.camera === "CONNECTED" ? "good" : "idle");
      els.lighting.textContent = st.lighting;
      setPill(els.lighting, st.lighting === "ON" ? "good" : "critical");
      els.strip.textContent = st.strip;
      setPill(els.strip, st.strip === "READ OK" ? "good" : st.strip === "READ FAILED" ? "critical" : "idle");
      els.sensors.textContent = "SIMULATED";
      setPill(els.sensors, "sim");
      els.btnLight.textContent = st.lighting === "ON" ? "TOGGLE" : "TOGGLE";
    }

    function setPill(el, levelKey) {
      el.classList.remove("st-good", "st-idle", "st-warn", "st-critical", "st-sim");
      el.classList.add("st-" + levelKey);
    }

    /* ── Processing status ──────────────────────────────────────── */

    const PROC_LABEL = {
      READY: "READY", CAPTURING: "CAPTURING", ANALYZING: "ANALYZING",
      CALIBRATING: "CALIBRATING", COMPLETE: "COMPLETE", ERROR: "ERROR",
    };

    function setProcessing(p) {
      els.proc.textContent = PROC_LABEL[p] || p;
      els.proc.dataset.key = p.toLowerCase();
      if (p === "CAPTURING") showMsg("Capturing frame...", "info");
    }

    /* ── Result handling + dashboard push ───────────────────────── */

    function handleResult(res) {
      if (!res.ok) {
        showMsg(res.message || "Measurement failed.", "error");
        device.state && (els.strip.textContent = "READ FAILED");
        renderDeviceStatus({ ...device.state, strip: "READ FAILED" });
        return;
      }
      hideMsg();

      const zones = window.DashboardData.PH_ZONES;
      const zone = res.zoneName
        ? { name: res.zoneName }
        : zones.find(z => z.id === window.DashboardData.phZone(res.ph.value).id)
          || window.DashboardData.phZone(res.ph.value);

      els.result.hidden = false;
      els.swatch.style.background = `rgb(${res.rgb.r},${res.rgb.g},${res.rgb.b})`;
      els.ph.textContent = res.ph.display;
      els.zone.textContent = zone.name || "--";
      const zk = { brightyellow: "critical", yellowgreen: "warn", greenzone: "good", blue: "good" }[
        (zone.id || window.DashboardData.phZone(res.ph.value).id)];
      els.zone.classList.remove("good", "low", "warn", "critical", "high");
      els.zone.classList.add(zk === "warn" ? "low" : zk || "good");
      els.rgb.textContent = `R ${res.rgb.r}  G ${res.rgb.g}  B ${res.rgb.b}`;
      els.method.textContent = res.method === "CALIBRATED_MATCH"
        ? "CALIBRATED MATCH" : "UNCALIBRATED ESTIMATE";
      if (device.state.mode === "SIMULATION") {
        els.method.textContent += " \u00B7 SIMULATED FRAME";
      }
      const conf = Math.round(res.confidence);
      els.confFill.style.width = conf + "%";
      els.confFill.className = "conf-fill " + (conf >= 67 ? "high" : conf >= 40 ? "mid" : "low");
      els.confPct.textContent = conf + "%";

      renderDeviceStatus({ ...device.state, strip: "READ OK" });
      els.btnRecapture.disabled = false;
      els.btnCalSave.disabled = !device.lastCapture;

      /* Persist + feed the dashboard (data.js validates again). */
      StripCalibration.recordMeasurement({
        ts: new Date().toISOString(),
        ph: res.ph.value,
        zoneId: zone.id, zoneName: zone.name,
        rgb: res.rgb, confidence: conf, method: res.method,
      });
      renderHistory();
      source.pushStripMeasurement({
        ph: res.ph.value,
        rgb: res.rgb,
        confidence: conf,
        method: res.method,
      });
    }

    /* ── Messages ───────────────────────────────────────────────── */

    function showMsg(text, kind) {
      els.msg.hidden = false;
      els.msg.dataset.key = kind;
      els.msg.textContent = text;
    }
    function hideMsg() { els.msg.hidden = true; }

    /* ── Calibration UI ─────────────────────────────────────────── */

    function renderCalibration() {
      els.calibState.textContent = StripCalibration.stateLabel();
      els.calibState.dataset.key = StripCalibration.isCalibrated() ? "complete" : "none";
      const pts = StripCalibration.listPoints();
      els.calibList.innerHTML = "";
      if (pts.length === 0) {
        const p = document.createElement("p");
        p.className = "calib-empty";
        p.textContent = "No calibration points yet. Capture a known-pH strip, enter its pH, then save.";
        els.calibList.appendChild(p);
        return;
      }
      for (const pt of pts.slice().reverse()) {
        const row = document.createElement("div");
        row.className = "calib-row";
        const left = document.createElement("span");
        left.innerHTML = `<span class="cp-ph">pH ${pt.ph.toFixed(1)}</span> <span class="cp-rgb">R${pt.r} G${pt.g} B${pt.b}</span>${pt.label ? ` <span class="cp-rgb">${escapeHtml(pt.label)}</span>` : ""}`;
        const del = document.createElement("button");
        del.className = "btn btn-danger btn-xs";
        del.type = "button";
        del.textContent = "\u00D7";
        del.setAttribute("aria-label", "Delete calibration point");
        del.addEventListener("click", () => { StripCalibration.removePoint(pt.id); });
        row.appendChild(left);
        row.appendChild(del);
        els.calibList.appendChild(row);
      }
    }

    function escapeHtml(s) {
      return s.replace(/[&<>"']/g, c => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
      }[c]));
    }

    /* ── Measurement history ────────────────────────────────────── */

    function renderHistory() {
      const items = StripCalibration.listMeasurements();
      els.histEmpty.hidden = items.length > 0;
      els.histBody.innerHTML = "";
      const shown = items.slice(0, 8);
      for (const m of shown) {
        const tr = document.createElement("tr");
        const t = new Date(m.ts);
        const hh = String(t.getHours()).padStart(2, "0") + ":" +
                   String(t.getMinutes()).padStart(2, "0") + ":" +
                   String(t.getSeconds()).padStart(2, "0");
        tr.innerHTML =
          `<td>${hh}</td>` +
          `<td>${m.ph != null ? m.ph.toFixed(2) : "--"}</td>` +
          `<td>${m.zoneName || "--"}</td>` +
          `<td>${m.confidence != null ? m.confidence + "%" : "--"}</td>` +
          `<td>${m.method === "CALIBRATED_MATCH" ? "CAL" : m.method === "UNCALIBRATED_ESTIMATE" ? "EST" : "--"}</td>` +
          `<td>${m.r != null ? `${m.r},${m.g},${m.b}` : "--"}</td>`;
        els.histBody.appendChild(tr);
      }
    }

    /* ── Controls wiring ────────────────────────────────────────── */

    els.btnCam.addEventListener("click", async () => {
      if (device.state.camera === "CONNECTED") {
        device.stop();
        els.btnCam.textContent = "START CAMERA";
        showMsg("Camera stopped - simulation frame in use.", "info");
      } else {
        await device.start();
        els.btnCam.textContent = device.state.camera === "CONNECTED" ? "STOP CAMERA" : "START CAMERA";
        if (device.state.camera !== "CONNECTED") {
          showMsg("Camera unavailable or permission denied - running on simulated frames.", "info");
        }
      }
      renderDeviceStatus(device.state);
    });

    els.btnLight.addEventListener("click", () => {
      device.setLighting(device.state.lighting !== "ON");
      renderDeviceStatus(device.state);
    });

    els.btnCapture.addEventListener("click", () => device.captureAndAnalyze());
    els.btnRecapture.addEventListener("click", () => device.captureAndAnalyze());

    /* ROI inputs -> device */
    function readROIInputs() {
      device.setROI({
        x: parseFloat(els.roiX.value), y: parseFloat(els.roiY.value),
        w: parseFloat(els.roiW.value), h: parseFloat(els.roiH.value),
      });
    }
    [els.roiX, els.roiY, els.roiW, els.roiH].forEach(inp =>
      inp.addEventListener("change", readROIInputs));

    /* Drag inside the preview moves the ROI (keeps size). */
    let dragging = false;
    els.view.addEventListener("pointerdown", e => { dragging = true; moveROI(e); });
    window.addEventListener("pointermove", e => { if (dragging) moveROI(e); });
    window.addEventListener("pointerup", () => { dragging = false; });

    function moveROI(e) {
      const rect = els.view.getBoundingClientRect();
      const r = device.getROI();
      const nx = (e.clientX - rect.left) / rect.width - r.w / 2;
      const ny = (e.clientY - rect.top) / rect.height - r.h / 2;
      const clamped = {
        x: Math.max(0, Math.min(1 - r.w, nx)),
        y: Math.max(0, Math.min(1 - r.h, ny)),
        w: r.w, h: r.h,
      };
      device.setROI(clamped);
      els.roiX.value = clamped.x.toFixed(2);
      els.roiY.value = clamped.y.toFixed(2);
    }

    /* Calibration controls */
    els.btnCalSave.addEventListener("click", () => {
      const ph = parseFloat(els.calibPh.value);
      if (!Number.isFinite(ph)) {
        showMsg('Enter the KNOWN pH of the reference strip first.', "error");
        return;
      }
      if (!device.lastCapture) {
        showMsg("No capture yet - run CAPTURE & ANALYZE first.", "error");
        return;
      }
      setProcessing("CALIBRATING");
      const res = device.calibrateLastCapture(ph);
      setTimeout(() => setProcessing("READY"), 400);
      if (!res.ok) { showMsg(res.error, "error"); return; }
      els.calibPh.value = "";
      showMsg(`Saved calibration point pH ${res.point.ph.toFixed(1)}.`, "info");
    });

    els.btnCalExport.addEventListener("click", () => {
      const blob = new Blob([StripCalibration.exportJSON()], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "delta-strip-calibration.json";
      a.click();
      URL.revokeObjectURL(a.href);
    });

    els.btnCalImportBtn.addEventListener("click", () => els.calibFile.click());
    els.calibFile.addEventListener("change", () => {
      const file = els.calibFile.files && els.calibFile.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const res = StripCalibration.importJSON(String(reader.result));
        showMsg(res.ok
          ? `Imported ${res.added} point(s)${res.skipped ? `, skipped ${res.skipped} invalid` : ""}.`
          : res.error, res.ok ? "info" : "error");
      };
      reader.readAsText(file);
      els.calibFile.value = "";
    });

    els.btnCalClear.addEventListener("click", () => {
      if (confirm("Delete ALL calibration points?")) StripCalibration.clearPoints();
    });

    els.btnHistClear.addEventListener("click", () => {
      if (confirm("Clear the measurement log?")) {
        StripCalibration.clearMeasurements();
        renderHistory();
      }
    });

    /* Keep panels fresh when points/history change elsewhere. */
    StripCalibration.subscribe(() => { renderCalibration(); renderHistory(); });

    renderCalibration();
    renderHistory();
    renderDeviceStatus(device.state);

    return device;
  }

  return { init };
})();
