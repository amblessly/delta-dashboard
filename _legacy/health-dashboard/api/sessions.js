/* POST /api/sessions - start/continue a detection session */
const { pool } = require("../_db.js");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const body = req.body;
  const key = typeof body.clientKey === "string" ? body.clientKey.slice(0, 64) : null;
  if (!key) return res.status(400).json({ error: "clientKey required" });
  try {
    const { rows } = await pool().query(
      `INSERT INTO detection_sessions (client_key, student_id, student_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (client_key) DO UPDATE SET ended_at = NULL
       RETURNING id, client_key, started_at`,
      [
        key,
        Number.isInteger(body.studentId) ? body.studentId : null,
        body.studentName ? String(body.studentName).slice(0, 120) : null
      ]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error("/api/sessions", e);
    res.status(500).json({ error: e.message });
  }
};