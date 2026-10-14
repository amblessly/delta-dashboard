/* POST /api/sessions — start/continue a health monitoring session.
   Body: { clientKey, studentCode } */
const { pool } = require("./_db.js");
const lib = require("./_lib.js");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const b = req.body || {};
  try {
    const result = await lib.startSession(pool(), { clientKey: b.clientKey, studentCode: b.studentCode });
    if (result.error) return res.status(400).json(result);
    res.status(201).json(result);
  } catch (e) {
    console.error("/api/sessions", e);
    res.status(500).json({ error: e.message });
  }
};
