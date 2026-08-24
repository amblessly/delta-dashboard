"use strict";

window.HealthEstimation = (function () {

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  /* Deterministic hash from face descriptor */
  function hashDescriptor(desc) {
    let h = 5381;
    const arr = desc instanceof Float32Array ? desc : desc;
    for (let i = 0; i < arr.length; i++) {
      h = ((h << 5) + h + Math.round(arr[i] * 1000)) | 0;
    }
    return Math.abs(h);
  }

  /* Seeded PRNG */
  function createRng(seed) {
    let s = seed || 1;
    return function () {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
  }

  /* Gaussian-ish from uniform (Box-Muller simplified) */
  function gauss(rng, mean, stddev) {
    const u1 = rng();
    const u2 = rng();
    const z = Math.sqrt(-2 * Math.log(Math.max(u1, 0.0001))) * Math.cos(2 * Math.PI * u2);
    return mean + z * stddev;
  }

  /**
   * Generate health result from face descriptor.
   * Same descriptor → same result (deterministic).
   * Different face → different result.
   */
  function estimate(descriptor) {
    const seed = hashDescriptor(descriptor);
    const rng = createRng(seed);

    /* Age: 16-65 range, centered around 22 */
    const age = Math.round(clamp(gauss(rng, 22, 8), 16, 65));

    /* Weight: correlated with age loosely */
    const ageFactor = (age - 18) / 47;
    const weight = Math.round(clamp(gauss(rng, 58 + ageFactor * 15, 10), 42, 110));

    /* Temperature: normal range 36.2-37.3 */
    const temperature = Number(clamp(gauss(rng, 36.6, 0.3), 36.0, 37.5).toFixed(1));

    /* Hydration: 55-92% */
    const hydration = Math.round(clamp(gauss(rng, 74, 10), 55, 92));

    /* Stress: 12-75% */
    const stress = Math.round(clamp(gauss(rng, 35, 14), 12, 75));

    /* Electrolytes: 55-90% */
    const electrolytes = Math.round(clamp(gauss(rng, 72, 9), 55, 90));

    /* Sodium: 132-146 mEq/L (normal range) */
    const sodium = Math.round(clamp(gauss(rng, 139, 3.5), 132, 146));

    /* Lactate: 0.8-3.8 mmol/L */
    const lactate = Number(clamp(gauss(rng, 1.8, 0.7), 0.8, 3.8).toFixed(1));

    return {
      age, weight, temperature, hydration, stress, electrolytes, sodium, lactate,
      seed,
    };
  }

  function getStatus(metric, value) {
    const rules = {
      electrolytes: v => v >= 65 ? { key: "good", label: "GOOD" } : v >= 50 ? { key: "low", label: "LOW" } : { key: "critical", label: "CRITICAL" },
      hydration:    v => v >= 68 ? { key: "good", label: "GOOD" } : v >= 55 ? { key: "low", label: "LOW" } : { key: "critical", label: "CRITICAL" },
      stress:       v => v < 30 ? { key: "normal", label: "LOW" } : v < 50 ? { key: "slight", label: "MODERATE" } : v < 70 ? { key: "high", label: "HIGH" } : { key: "critical", label: "CRITICAL" },
      sodium:       v => v >= 135 && v <= 145 ? { key: "normal", label: "NORMAL" } : v >= 130 && v <= 150 ? { key: "elevated", label: "ELEVATED" } : { key: "critical", label: "CRITICAL" },
      lactate:      v => v < 2.0 ? { key: "normal", label: "NORMAL" } : v < 3.5 ? { key: "elevated", label: "ELEVATED" } : { key: "critical", label: "CRITICAL" },
      temperature:  v => v < 37.0 ? { key: "normal", label: "NORMAL" } : v < 37.5 ? { key: "slight", label: "SLIGHT" } : { key: "critical", label: "CRITICAL" },
    };
    return (rules[metric] || (() => ({ key: "normal", label: "NORMAL" })))(value);
  }

  function generateRecommendations(result) {
    const recs = [];
    if (result.hydration < 62) recs.push({ id: "hydration", icon: "cyan", theme: "amber", title: "Drink 500 ml water soon", desc: `Hydration at <b>${result.hydration}%</b> - encourage adequate fluid intake and monitor for heat illness symptoms.` });
    else if (result.hydration >= 78) recs.push({ id: "hydration", icon: "cyan", theme: "green", title: "Hydration looks good", desc: `Hydration at <b>${result.hydration}%</b> - maintain regular water intake.` });
    if (result.stress >= 55) recs.push({ id: "stress", icon: "purple", theme: "red", title: "5-min breathing exercise", desc: `Stress at <b>${result.stress}%</b> - reduce activity, rest in a cooler area, monitor for dizziness or nausea.` });
    else if (result.stress >= 35) recs.push({ id: "stress", icon: "purple", theme: "amber", title: "Consider a short break", desc: `Stress at <b>${result.stress}%</b> - mild elevation detected. A brief rest may help.` });
    if (result.lactate >= 2.5) recs.push({ id: "lactate", icon: "amber", theme: "amber", title: "Lactate elevated", desc: `Lactate at <b>${result.lactate} mmol/L</b> - tone down activity and reassess after adequate recovery.` });
    if (result.electrolytes < 60) recs.push({ id: "electrolytes", icon: "green", theme: "amber", title: "Electrolyte balance trending down", desc: `Electrolytes <b>${result.electrolytes}%</b> - an isotonic drink will restore balance.` });
    if (recs.length === 0) recs.push({ id: "hydration", icon: "cyan", theme: "green", title: "All indicators normal", desc: "Health estimates appear within normal ranges. Maintain current activity level and hydration." });
    return recs.slice(0, 3);
  }

  function buildResult(descriptor) {
    const raw = estimate(descriptor);
    return {
      age: raw.age,
      weight: raw.weight,
      metrics: {
        electrolytes: { value: raw.electrolytes, unit: "%", status: getStatus("electrolytes", raw.electrolytes) },
        hydration:    { value: raw.hydration, unit: "%", status: getStatus("hydration", raw.hydration) },
        stress:       { value: raw.stress, unit: "%", status: getStatus("stress", raw.stress) },
        sodium:       { value: raw.sodium, unit: "mEq/L", status: getStatus("sodium", raw.sodium) },
        lactate:      { value: raw.lactate, unit: "mmol/L", status: getStatus("lactate", raw.lactate) },
        temperature:  { value: raw.temperature, unit: "\u00B0C", status: getStatus("temperature", raw.temperature) },
      },
      recommendations: generateRecommendations(raw),
      seed: raw.seed,
    };
  }

  return { buildResult, estimate, getStatus };
})();
