/* POST /api/sessions/end — end a monitoring session. Body: { clientKey } */
const { pool } = require("../_db.js");
const lib = require("../_lib.js");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const b = req.body || {};
  try {
    const result = await lib.endSession(pool(), b.clientKey);
    if (result.error) return res.status(400).json(result);
    res.status(200).json(result);
  } catch (e) {
    console.error("/api/sessions/end", e);
    res.status(500).json({ error: e.message });
  }
};
