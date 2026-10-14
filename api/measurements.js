/* GET /api/measurements?limit=N | POST /api/measurements
   POST is the ingestion endpoint for sensors / Raspberry Pi.
   Body: {
     studentCode,                       required — readings belong to one student
     source: "temperature_sensor",      required — where this reading came from
     sessionClientKey?,                 optional — active monitoring session
     recordedAt?,                       optional ISO timestamp (default now)
     metrics: { temperature?, hydration?, stress?, electrolytes?, sodium?, lactate? }
   }
   Invalid or out-of-range values are REJECTED (never coerced to 0). */
const { pool } = require("./_db.js");
const lib = require("./_lib.js");

module.exports = async (req, res) => {
  if (req.method === "GET") {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 50));
    try {
      const { rows } = await pool().query(
        `SELECT m.id, s.student_code AS "studentCode", m.source,
                m.electrolytes_pct, m.hydration_pct, m.stress_pct,
                m.sodium_meq_l, m.lactate_mmol_l, m.temperature_c,
                m.recorded_at AS "recordedAt"
         FROM measurements m LEFT JOIN students s ON s.id = m.student_id
         ORDER BY m.recorded_at DESC LIMIT $1`,
        [limit]
      );
      return res.status(200).json(rows);
    } catch (e) {
      console.error("GET /api/measurements", e);
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === "POST") {
    try {
      const result = await lib.insertMeasurement(pool(), req.body || {});
      if (result.error) return res.status(400).json(result);
      return res.status(201).json(result);
    } catch (e) {
      console.error("POST /api/measurements", e);
      return res.status(500).json({ error: e.message });
    }
  }

  res.status(405).json({ error: "Method not allowed" });
};
