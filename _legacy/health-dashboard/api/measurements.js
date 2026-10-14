/* GET /api/measurements?limit=N | POST /api/measurements */
const { pool } = require("./_db.js");

const num = v => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));

module.exports = async (req, res) => {
  if (req.method === "GET") {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 50));
    try {
      const { rows } = await pool().query(
        "SELECT * FROM measurements ORDER BY recorded_at DESC LIMIT $1",
        [limit]
      );
      return res.status(200).json(rows);
    } catch (e) {
      console.error("GET /api/measurements", e);
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === "POST") {
    const b = req.body;
    const m = b.metrics || {};
    try {
      const { rows } = await pool().query(
        `INSERT INTO measurements
           (session_client_key, student_id, student_name,
            electrolytes_pct, hydration_pct, stress_pct,
            sodium_meq_l, lactate_mmol_l, temperature_c)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id, recorded_at`,
        [
          b.sessionClientKey ? String(b.sessionClientKey).slice(0, 64) : null,
          Number.isInteger(b.studentId) ? b.studentId : null,
          b.studentName ? String(b.studentName).slice(0, 120) : null,
          num(m.electrolytes), num(m.hydration), num(m.stress),
          num(m.sodium), num(m.lactate), num(m.temperature),
        ]
      );
      return res.status(201).json(rows[0]);
    } catch (e) {
      console.error("POST /api/measurements", e);
      return res.status(500).json({ error: e.message });
    }
  }

  res.status(405).json({ error: "Method not allowed" });
};