/* POST /api/sessions/end - end a detection session */
const { pool } = require("../_db.js");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const body = req.body;
  if (!body.clientKey) return res.status(400).json({ error: "clientKey required" });
  try {
    const { rowCount } = await pool().query(
      `UPDATE detection_sessions SET ended_at = now()
       WHERE client_key = $1 AND ended_at IS NULL`,
      [String(body.clientKey).slice(0, 64)]
    );
    res.status(200).json({ updated: rowCount });
  } catch (e) {
    console.error("/api/sessions/end", e);
    res.status(500).json({ error: e.message });
  }
};