"use strict";

/* stress_estimator.js — Client-side weighted stress score calculator.

   Combines temperature-based stress contribution (from the Python
   stress_estimator via /thermal endpoint) with other available
   sensor data (electrolytes, hydration, sodium, lactate) from the
   health API.

   This is an ESTIMATED physiological stress indicator — NOT a
   medical diagnosis.  Temperature contribution is based on
   MLX90640 infrared surface temperature, which measures skin
   temperature, NOT core body temperature.

   If only temperature is available (no other sensors), the result
   is labeled "Temperature-based stress estimate" rather than
   simply "Stress".
*/

window.StressEstimator = (function () {

  /* ── Default weights when all sensors are available ──────────── */
  const WEIGHTS = {
    temperature:    0.25,
    electrolytes:   0.20,
    hydration:      0.20,
    sodium:         0.15,
    lactate:        0.10,
    activity:       0.10,  /* placeholder for future activity sensor */
  };

  const AVAILABLE_KEYS = ["temperature", "electrolytes", "hydration", "sodium", "lactate"];

  /* ── Stress categories (0-100) ──────────────────────────────── */
  const CATEGORIES = [
    { max: 24,  label: "Low",      color: "green" },
    { max: 49,  label: "Mild",     color: "amber" },
    { max: 74,  label: "Moderate", color: "orange" },
    { max: 89,  label: "High",     color: "red" },
    { max: 100, label: "Critical", color: "red" },
  ];

  function getCategory(score) {
    for (const cat of CATEGORIES) {
      if (score <= cat.max) return cat;
    }
    return CATEGORIES[CATEGORIES.length - 1];
  }

  /* ── Normalize a raw sensor value to a 0-100 "component" ───────
     Each sensor type maps differently:
     - Electrolytes: 50% is ideal center, deviations are stress
     - Hydration: low = stress, high = fine
     - Sodium: 140 is ideal center, deviations are stress
     - Lactate: low is ideal, high is stress
     - Temperature: use the contribution directly (already 0-100)
  ──────────────────────────────────────────────────────────────── */
  function normalizeSensor(key, value) {
    if (value == null) return null;
    switch (key) {
      case "temperature":
        /* Temperature contribution is already 0-100 from the Python estimator */
        return value;
      case "electrolytes": {
        /* 50% is ideal; deviation from 50 → stress */
        const dev = Math.abs(value - 50);
        return Math.min(100, (dev / 50) * 100);
      }
      case "hydration": {
        /* Below 45% is increasingly stressful */
        if (value >= 60) return Math.max(0, (1 - (value - 60) / 40) * 10);
        if (value >= 45) return 10 + ((60 - value) / 15) * 30;
        return 40 + ((45 - value) / 45) * 60;
      }
      case "sodium": {
        /* 135-145 is ideal; deviations are stressful */
        if (value >= 130 && value <= 155) {
          const dev = Math.max(Math.abs(value - 140) - 5, 0);
          return Math.min(100, (dev / 15) * 100);
        }
        const dev = Math.min(Math.abs(value - 140), 60);
        return Math.min(100, 40 + (dev / 60) * 60);
      }
      case "lactate": {
        /* Below 2 mmol/L is normal; above is increasingly stressful */
        if (value <= 2.0) return value * 5;
        if (value <= 4.0) return 10 + ((value - 2) / 2) * 40;
        return 50 + Math.min(50, ((value - 4) / 6) * 50);
      }
      default:
        return null;
    }
  }

  /* ── Main estimation function ───────────────────────────────────
     Inputs:
       thermalStress: data from /thermal endpoint (Python estimator)
       healthMetrics: data from /api/students/:code/health

     Returns:
       {
         score: 0-100,
         category: "Low"|"Mild"|"Moderate"|"High",
         confidence: 0-100,
         label: string (description of what the score represents),
         tempContribution: 0-100 or null,
         tempDeviation: °C or null,
         tempBaseline: °C or null,
         tempCalibrated: bool,
         tempLabel: string,
         components: { key: normalizedValue },
         availableSensors: string[],
         isTemperatureOnly: bool,
       }
  ──────────────────────────────────────────────────────────────── */
  function estimate(thermalStress, healthMetrics) {
    const result = {
      score: 0,
      category: "Low",
      confidence: 0,
      label: "Awaiting sensor data",
      tempContribution: null,
      tempDeviation: null,
      tempBaseline: null,
      tempCalibrated: false,
      tempLabel: "",
      components: {},
      availableSensors: [],
      isTemperatureOnly: false,
    };

    if (!thermalStress && !healthMetrics) return result;

    /* Extract temperature contribution from thermal endpoint */
    let tempContrib = null;
    if (thermalStress) {
      tempContrib = thermalStress.contribution;
      result.tempContribution = tempContrib;
      result.tempDeviation = thermalStress.deviation;
      result.tempBaseline = thermalStress.baseline;
      result.tempCalibrated = thermalStress.calibrated;
      result.tempLabel = thermalStress.label || "";
      result.confidence = thermalStress.confidence || 0;
    }

    /* Collect available sensor components */
    const components = {};
    const available = [];

    if (tempContrib != null) {
      components.temperature = normalizeSensor("temperature", tempContrib);
      if (components.temperature != null) available.push("temperature");
    }

    /* Map health metrics to our sensor keys */
    const metricKeyMap = {
      electrolytes: "electrolytes",
      hydration: "hydration",
      sodium: "sodium",
      lactate: "lactate",
    };

    if (healthMetrics && healthMetrics.metrics) {
      for (const [sensorKey, metricKey] of Object.entries(metricKeyMap)) {
        const m = healthMetrics.metrics[metricKey];
        if (m && m.value != null && m.state !== "NO_SIGNAL") {
          const norm = normalizeSensor(sensorKey, m.value);
          if (norm != null) {
            components[sensorKey] = norm;
            available.push(sensorKey);
          }
        }
      }
    }

    result.availableSensors = available;
    result.components = components;

    if (available.length === 0) {
      result.score = 0;
      result.category = "Low";
      result.label = "Awaiting valid sensor data";
      result.isTemperatureOnly = false;
      return result;
    }

    /* ── Dynamically redistribute weights ───────────────────────
       Start with default weights, zero out unavailable sensors,
       then redistribute proportionally among available sensors.
    ─────────────────────────────────────────────────────────── */
    const weights = {};
    let totalWeight = 0;
    for (const key of available) {
      weights[key] = WEIGHTS[key] || 0.1;
      totalWeight += weights[key];
    }
    /* Normalize so weights sum to 1.0 */
    for (const key of available) {
      weights[key] /= totalWeight;
    }

    /* ── Compute weighted score ─────────────────────────────── */
    let score = 0;
    for (const key of available) {
      score += components[key] * weights[key];
    }
    score = Math.round(Math.max(0, Math.min(100, score)));

    const cat = getCategory(score);
    result.score = score;
    result.category = cat.label;

    /* ── Label depends on which sensors are available ────────── */
    const hasOnlyTemp = available.length === 1 && available[0] === "temperature";
    result.isTemperatureOnly = hasOnlyTemp;

    if (hasOnlyTemp) {
      if (!thermalStress || !thermalStress.calibrated) {
        result.label = "Calibrating temperature baseline";
      } else {
        result.label = "Temperature-based stress estimate";
      }
    } else {
      result.label = "Estimated physiological stress indicator";
    }

    /* ── Recalculate confidence from available data ────────────
       If we got confidence from Python estimator, use it as base
       and adjust for the number of available sensors.
    ─────────────────────────────────────────────────────────── */
    const sensorBonus = Math.min(30, (available.length - 1) * 10);
    result.confidence = Math.min(100, result.confidence + sensorBonus);

    return result;
  }

  /* ── Public API ────────────────────────────────────────────── */
  return { estimate, getCategory, CATEGORIES };
})();
