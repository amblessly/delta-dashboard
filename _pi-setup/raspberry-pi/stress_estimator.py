#!/usr/bin/env python3
"""stress_estimator.py — Temperature-based physiological stress estimator.

Heuristic module that estimates a physiological stress indicator from
MLX90640 infrared surface temperature readings.  This is NOT a medical
diagnosis tool.  MLX90640 measures skin surface (infrared) temperature,
NOT core body temperature.  Skin temperature varies with ambient
conditions, proximity, angle, clothing, recent activity, and many
non-stress-related factors.

The algorithm works by:
  1. Building a per-student personal baseline from recent valid readings
  2. Measuring deviation of the current reading from that baseline
  3. Measuring rate of change (trend) across recent readings
  4. Producing a temperature "contribution" (0-100) and confidence (0-100)

The final stress SCORE is computed client-side (stress_estimator.js) by
combining this temperature contribution with other available sensor
data (electrolytes, hydration, sodium, lactate).  Temperature alone
should never be presented as "stress" — the label must be
"Estimated stress indicator" or "Temperature-based stress estimate".
"""

import time
import math
from collections import defaultdict, deque

# ── Configuration ───────────────────────────────────────────────
# Rolling window: keep the last N valid readings per student
MAX_HISTORY = 30
# Minimum readings before a personal baseline is established
MIN_BASELINE_READINGS = 1
# Default starting baseline (°C) — human body core temperature
DEFAULT_BASELINE = 37.0
# Time window (seconds) for "recent" readings used in baseline
BASELINE_WINDOW_S = 600  # 10 minutes
# Rate-of-change lookback (index gap between current and previous)
TREND_LOOKBACK = 3

# Absolute temperature thresholds (°C) for skin/surface reading
# MLX90640 measures infrared surface (skin) temperature.
# Normal skin temp: 33-35°C. Room ambient: 20-25°C.
ABS_TEMP_THRESHOLDS = [
    (20.0,  0),    # room ambient — no stress
    (32.0,  0),    # below normal skin temp — no stress
    (34.0,  0),    # normal skin temperature baseline
    (35.0, 35),    # slightly elevated
    (36.0, 70),    # elevated
    (38.0, 100),   # high/critical
]

# Deviation thresholds (°C) for personal baseline offset modifier
DEV_THRESHOLDS = [
    (0.0,  0),
    (0.3, 10),
    (0.6, 25),
    (1.0, 45),
    (1.5, 70),
    (2.0, 100),
]

# Rate-of-change multiplier: rapid change increases contribution
RATE_MULTIPLIER_THRESHOLD = 0.15
RATE_AMPLIFICATION = 1.2

# Confidence components (each 0-25, total 0-100)
CONF_BASELINE_MIN = 5
CONF_BASELINE_MAX = 25
CONF_SENSOR_MIN = 5
CONF_SENSOR_MAX = 25
CONF_STABILITY_MAX = 25
CONF_CONSISTENCY_MAX = 25


class StudentThermalState:
    """Per-student rolling history and baseline for temperature stress."""

    def __init__(self):
        # deque of (timestamp, temperature_c) in chronological order
        self.history: deque = deque(maxlen=MAX_HISTORY)
        self.last_temp: float | None = None
        self.last_time: float | None = None

    def add_reading(self, temp_c: float, timestamp: float | None = None):
        """Record a valid temperature reading."""
        ts = timestamp or time.time()
        self.history.append((ts, temp_c))
        self.last_temp = temp_c
        self.last_time = ts

    def get_baseline(self, now: float | None = None) -> float | None:
        """Compute personal baseline: average of recent readings within BASELINE_WINDOW_S.

        Returns None if fewer than MIN_BASELINE_READINGS are available.
        The baseline represents the student's typical skin temperature
        under recent conditions — NOT a medical normal range.
        """
        ref = now or time.time()
        cutoff = ref - BASELINE_WINDOW_S
        recent = [t for ts, t in self.history if ts >= cutoff]
        if len(recent) < MIN_BASELINE_READINGS:
            return DEFAULT_BASELINE
        return sum(recent) / len(recent)

    def get_deviation(self, current: float, now: float | None = None) -> float | None:
        """Absolute deviation of current temp from personal baseline (°C).

        Returns None if no baseline is established yet.
        """
        baseline = self.get_baseline(now)
        if baseline is None:
            return None
        return abs(current - baseline)

    def get_signed_delta(self, current: float, now: float | None = None) -> float | None:
        """Signed delta: current - baseline. Positive = warmer than baseline."""
        baseline = self.get_baseline(now)
        if baseline is None:
            return None
        return current - baseline

    def get_rate_of_change(self) -> float | None:
        """Rate of change: current temp minus previous temp (°C per reading).

        A positive value means temperature is rising.  A large magnitude
        indicates rapid change which may increase stress contribution.
        Returns None if fewer than 2 readings exist.
        """
        if len(self.history) < 2:
            return None
        curr = self.history[-1][1]
        idx = max(0, len(self.history) - 1 - TREND_LOOKBACK)
        prev = self.history[idx][1]
        return curr - prev

    def get_baseline_quality(self, now: float | None = None) -> float:
        """0-1 quality of the baseline (more readings = better)."""
        ref = now or time.time()
        cutoff = ref - BASELINE_WINDOW_S
        count = sum(1 for ts, _ in self.history if ts >= cutoff)
        # Full quality at 10+ readings, linear ramp from MIN_BASELINE_READINGS
        if count >= 10:
            return 1.0
        if count < MIN_BASELINE_READINGS:
            return 0.0
        return (count - MIN_BASELINE_READINGS) / (10 - MIN_BASELINE_READINGS)

    def get_measurement_consistency(self) -> float:
        """0-1 consistency: how stable are recent readings (low std dev = high).

        Uses the last MAX_HISTORY readings.  A low standard deviation
        means the sensor is giving consistent results.
        """
        if len(self.history) < 3:
            return 0.0
        temps = [t for _, t in self.history]
        mean = sum(temps) / len(temps)
        variance = sum((t - mean) ** 2 for t in temps) / len(temps)
        std = math.sqrt(variance)
        # Consistency: 1.0 at std < 0.1°C, 0.0 at std > 1.0°C
        return max(0.0, min(1.0, 1.0 - (std - 0.1) / 0.9))


# ── Global student state registry ────────────────────────────────
_students: dict[str, StudentThermalState] = defaultdict(StudentThermalState)


def get_student_state(student_code: str | int) -> StudentThermalState:
    """Get or create the thermal state for a student."""
    key = str(student_code)
    return _students[key]


# ── Core estimation functions ────────────────────────────────────

def temperature_to_contribution(temp_c: float) -> float:
    """Map absolute skin temperature (°C) to a 0-100 stress contribution.

    Uses the user-calibrated absolute ranges:
      <33°C = Low, 33-35°C = Normal, 35-36°C = Elevated,
      36-37°C = High, >37°C = Critical
    """
    if temp_c is None:
        return 0.0
    for i in range(len(ABS_TEMP_THRESHOLDS) - 1):
        lo_t, lo_v = ABS_TEMP_THRESHOLDS[i]
        hi_t, hi_v = ABS_TEMP_THRESHOLDS[i + 1]
        if temp_c <= hi_t:
            if temp_c <= lo_t:
                return lo_v
            frac = (temp_c - lo_t) / (hi_t - lo_t)
            return lo_v + frac * (hi_v - lo_v)
    return ABS_TEMP_THRESHOLDS[-1][1]


def deviation_to_modifier(deviation: float | None) -> float:
    """Map personal baseline deviation (°C) to an additional 0-100 modifier.

    A large deviation from one's own baseline adds extra stress signal.
    """
    if deviation is None:
        return 0.0
    for i in range(len(DEV_THRESHOLDS) - 1):
        lo_dev, lo_val = DEV_THRESHOLDS[i]
        hi_dev, hi_val = DEV_THRESHOLDS[i + 1]
        if deviation <= hi_dev:
            if deviation <= lo_dev:
                return lo_val
            frac = (deviation - lo_dev) / (hi_dev - lo_dev)
            return lo_val + frac * (hi_val - lo_val)
    return DEV_THRESHOLDS[-1][1]


def temp_label(temp_c: float | None, calibrated: bool) -> str:
    """Human-readable label for absolute temperature range."""
    if not calibrated:
        return "Calibrating baseline"
    if temp_c is None:
        return "No reading"
    if temp_c > 42:
        return "Sensor near heat source"
    if temp_c < 33:
        return "Low skin temperature"
    if temp_c < 35:
        return "Normal skin temperature"
    if temp_c < 36:
        return "Elevated skin temperature"
    if temp_c < 37:
        return "High skin temperature"
    return "Critical skin temperature"


def apply_rate_modifier(base_contribution: float, rate: float | None) -> float:
    """Amplify contribution if temperature is changing rapidly.

    Rapid increase or decrease should raise the stress estimate,
    because physiological instability is itself a stress indicator.
    A stable temperature contributes less.
    """
    if rate is None:
        return base_contribution
    abs_rate = abs(rate)
    if abs_rate < RATE_MULTIPLIER_THRESHOLD:
        return base_contribution
    # Linearly scale multiplier from 1.0 to RATE_AMPLIFICATION
    excess = min(abs_rate - RATE_MULTIPLIER_THRESHOLD, 0.3)
    multiplier = 1.0 + (excess / 0.3) * (RATE_AMPLIFICATION - 1.0)
    return min(100.0, base_contribution * multiplier)


def calculate_temperature_contribution(student_code: str | int,
                                       current_temp: float,
                                       timestamp: float | None = None) -> dict:
    """Compute the temperature-based stress contribution for a student.

    Returns a dict with:
      - contribution: 0-100 temperature stress contribution
      - deviation: °C from baseline (or None)
      - signed_delta: + warmer / - cooler than baseline (or None)
      - rate: °C change per reading (or None)
      - baseline: personal baseline temperature (or None)
      - baseline_quality: 0-1
      - calibrated: bool — whether baseline is established
      - label: human-readable category

    This is an ESTIMATED indicator, not a medical diagnosis.
    MLX90640 measures surface (skin) temperature, which is affected
    by ambient temperature, humidity, sensor distance/angle,
    recent activity, clothing, and many non-stress factors.
    """
    state = get_student_state(student_code)
    now = timestamp or time.time()

    # Record this reading
    state.add_reading(current_temp, now)

    # Compute components
    baseline = state.get_baseline(now)
    deviation = state.get_deviation(current_temp, now)
    signed_delta = state.get_signed_delta(current_temp, now)
    rate = state.get_rate_of_change()
    calibrated = len([ts for ts, _ in state.history if ts >= now - BASELINE_WINDOW_S]) >= MIN_BASELINE_READINGS

    # Primary contribution from absolute temperature
    # Cap at 37°C for contribution calc — readings above that are likely
    # board heat interference, not actual skin temperature
    effective_temp = min(current_temp, 42.0)
    base_contrib = temperature_to_contribution(effective_temp)

    # Add personal deviation modifier (up to +30% extra if far from own baseline)
    dev_mod = deviation_to_modifier(deviation) * 0.3
    contrib = base_contrib + dev_mod

    # Apply rate-of-change modifier
    contrib = apply_rate_modifier(contrib, rate)
    contrib = max(0.0, min(100.0, contrib))

    # Category label
    label = temp_label(current_temp, calibrated)

    return {
        "contribution": round(contrib, 1),
        "deviation": round(deviation, 2) if deviation is not None else None,
        "signedDelta": round(signed_delta, 2) if signed_delta is not None else None,
        "rate": round(rate, 3) if rate is not None else None,
        "baseline": round(baseline, 2) if baseline is not None else None,
        "baselineQuality": round(state.get_baseline_quality(now), 2),
        "measurementConsistency": round(state.get_measurement_consistency(), 2),
        "calibrated": calibrated,
        "label": label,
        "readingCount": len(state.history),
    }


def calculate_confidence(student_code: str | int,
                         has_ambient_compensation: bool = False) -> float:
    """Compute a 0-100 confidence score for the temperature-based estimate.

    Confidence reflects how reliable the current estimate is, based on:
      - Baseline quality (enough readings, recent enough)
      - Sensor reading quality (valid range, reasonable values)
      - Environmental stability (simplified: assume stable unless told otherwise)
      - Measurement consistency (low variance in recent readings)

    Returns a rounded integer (0-100).
    """
    state = get_student_state(student_code)

    # Baseline quality (0-25)
    bq = state.get_baseline_quality()
    baseline_score = CONF_BASELINE_MIN + bq * (CONF_BASELINE_MAX - CONF_BASELINE_MIN)

    # Sensor quality (0-25): valid if we have a recent reading in range
    sensor_score = CONF_SENSOR_MIN
    if state.last_temp is not None and 25.0 <= state.last_temp <= 45.0:
        # Full sensor score if reading is well within physiological bounds
        sensor_score = CONF_SENSOR_MAX
    elif state.last_temp is not None:
        sensor_score = (CONF_SENSOR_MIN + CONF_SENSOR_MAX) / 2

    # Environmental stability (0-25): simplified
    stability_score = CONF_STABILITY_MAX * 0.6  # default: moderate confidence
    if has_ambient_compensation:
        stability_score = CONF_STABILITY_MAX * 0.8

    # Measurement consistency (0-25)
    consistency = state.get_measurement_consistency()
    consistency_score = consistency * CONF_CONSISTENCY_MAX

    total = baseline_score + sensor_score + stability_score + consistency_score
    return round(max(0.0, min(100.0, total)))
