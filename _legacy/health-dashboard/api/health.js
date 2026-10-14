/* GET /api/health - health check */
const { pool } = require("./_db.js");

module.exports = async (req, res) => {
  try {
    await pool().query("SELECT 1");
    res.status(200).json({ ok: true, db: "connected" });
  } catch (e) {
    console.error("/api/health", e);
    res.status(500).json({ ok: false, error: e.message });
  }
};