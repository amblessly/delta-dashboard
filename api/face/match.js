/* POST /api/face/match — match a live descriptor against registered faces.
   Body: { descriptor: [128 floats] }
   Returns the matched student identity or matched:false (UNKNOWN).
   Registered descriptors are compared server-side and never exposed. */
const { pool } = require("./_db.js");
const lib = require("../_lib.js");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const b = req.body || {};
  try {
    const result = await lib.matchFace(pool(), b.descriptor);
    if (result.error) return res.status(400).json(result);
    res.status(200).json(result);
  } catch (e) {
    console.error("/api/face/match", e);
    res.status(500).json({ error: e.message });
  }
};
