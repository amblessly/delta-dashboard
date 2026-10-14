/* GET /api/students/:code/health — real health data for one student.
   Every metric carries { value, unit, state, recordedAt, source }.
   Without a real reading the state is NO_SIGNAL and value is null.
   States: LIVE | RECENT | STALE | NO_SIGNAL */
const { pool } = require("../_db.js");
const lib = require("../../_lib.js");

module.exports = async (req, res) => {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const result = await lib.getHealthByCode(pool(), req.query.code);
    if (result.error) return res.status(400).json(result);
    if (result.notFound) return res.status(404).json({ error: "Student not found" });
    res.status(200).json(result);
  } catch (e) {
    console.error("/api/students/:code/health", e);
    res.status(500).json({ error: e.message });
  }
};
