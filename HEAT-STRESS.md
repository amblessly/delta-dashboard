# Heat Stress Computation - Derivation & Data Flow

## Formula (per project spec)

```
Heat Stress % = (0.55 x T) + (0.25 x ELEC) + (0.20 x LAC)
```

Classification: **0-33% LOW | 34-66% MODERATE | 67-100% HIGH**

## Step 1: Data Collection (sensors)

| Sensor      | Raw unit  | Role in formula |
|-------------|-----------|-----------------|
| Temperature | degrees C | T   (weight .55) |
| Electrolytes| % index   | ELEC(weight .25) |
| Lactate     | mmol/L    | LAC (weight .20) |
| Hydration   | %         | NOT in formula - monitoring/recommendations only |

## Step 2: Normalization (raw -> 0-100 scale)

Each raw reading is mapped onto a standardized 0-100 risk scale before the
weighted sum, because the raw units are incompatible (degC vs mmol/L vs %).

### T - Temperature
Linear map across the physiological heat-risk band:

```
T_norm = ((T_degC - 36.5) / 3.0) * 100     clamped to [0, 100]
```

- 36.5C -> 0%  : thermoneutral baseline (resting body temp)
- 37.4C -> 30% : mild elevation
- 38.0C -> 50% : significant heat load
- 39.5C+->100% : heat-illness emergency threshold

Rationale: core/skin temp above ~37.5C during activity escalates heat-illness
risk; 39.5C+ is the emergency zone in sports-med guidance.

### ELEC - Sweat electrolyte index
The dashboard already expresses electrolytes on a 0-100% index whose bands
match the spec's sodium-loss zones, so it passes through unchanged:

```
ELEC_norm = clamp(electrolytes_value, 0, 100)
```

Spec cross-reference: <30 mEq/L sweat sodium = low loss, 30-60 = moderate,
>60 = high. The index bands (<33 / 34-66 / >=67) mirror these.

### LAC - Lactate
Linear map over the clinical range for exertion:

```
LAC_norm = ((LAC_mmol_L - 1.0) / 4.0) * 100 clamped to [0, 100]
```

- 1.0 mmol/L -> 0%   : resting baseline
- 2.0 mmol/L -> 25%  : moderate buildup (spec: <2 = mild)
- 4.0 mmol/L -> 75%  : high buildup (spec: >2 = high)
- 5.0 mmol/L -> 100% : severe

## Step 3: Weighted Sum & Classification

```js
pct   = 0.55*T + 0.25*ELEC + 0.20*LAC     // rounded to 1 decimal
level = pct <= 33 ? LOW : pct <= 66 ? MODERATE : HIGH
```

Worked example with typical dashboard values:
T=37.4C -> 30 | ELEC=72 -> 72 | LAC=2.8 -> 45

```
HS% = 0.55(30) + 0.25(72) + 0.20(45)
    = 16.5     + 18        + 9
    = 43.5%    => MODERATE
```

Temperature carries the heaviest weight (.55) because heat illness is driven
primarily by thermoregulation failure; lactate (.20) confirms muscular
exertion buildup; electrolytes (.25) captures dehydration-related salt loss.

## Sweat pH Strip Zones (spec)

Simulated pH follows exertion intensity:
`target_ph = 6.7 - intensity * 3.0`, where
`intensity = avg(stress%, lactate_norm%)`. Smoothed random walk keeps it organic.

| Zone          | pH range  | Meaning                                        |
|---------------|-----------|------------------------------------------------|
| BLUE          | >= 5.4    | default / resting sweat                        |
| GREEN         | 4.6 - 5.3 | mild exertion, moderate lactate, low Na loss   |
| YELLOW-GREEN  | 3.9 - 4.5 | heavy exertion, ~2 mmol/L lactate, 30-60 Na    |
| BRIGHT YELLOW | <= 3.8    | extreme exhaustion, >2 lactate, >60 Na loss    |

## Scientific Basis: Bromocresol Green (BCG) Colorimetric Strip

The sweat pH strip visualized on the dashboard (`ph-stripbar`) mirrors the
actual BCG indicator chemistry used by the device:

- BCG detects **pH 3.8 to 5.4**: yellow below pH 3.8, blue above pH 5.4,
  green in between.
- Readings outside the band saturate at the end colors, which is why the
  dashboard treats >= 5.4 as a single BLUE "default / resting" zone and
  <= 3.8 as the extreme BRIGHT YELLOW zone.

References:

- Al Tamimi et al. (2023) - nanocellulose paper-based indicator with BCG for
  chicken breast spoilage; demonstrated yellow-to-blue color transition with
  rising pH, quantified through smartphone RGB image analysis. Basis for the
  device's strip + camera + controlled illumination + image-processing chain.
- Zhou et al. (2025) - colorimetric sweat sensor using BCG; validated that
  known pH solutions produce distinguishable colors via RGB processing,
  establishing a blue (higher pH) to yellowish-green (lower pH) scale for
  sweat acidity analysis.

Dashboard mapping of the BCG scale to exertion zones:

```
pH:  3.4   3.8      4.5        5.3       5.4+    7.0
     | BRIGHT YELLOW | YELLOW-GREEN | GREEN |  BLUE  |
     | extreme       | heavy        | mild  | resting|
```

## Where it lives in code

- `data.js`: `normTemp()`, `normLac()`, `computeHeatStress()`, `PH_ZONES`,
  `phZone()` - pure functions, no DOM. Swap the simulated source with real
  sensor polling and these run unchanged.
- `main.js`: `renderHeatStress()`, `renderPhStrip()` - display only.
