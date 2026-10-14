/* GET /api/students — student profiles (identity data only).
   Face descriptors are NEVER included in this response. */
const { pool } = require("./_db.js");
const lib = require("../_lib.js");

module.exports = async (req, res) => {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    res.status(200).json(await lib.listStudents(pool()));
  } catch (e) {
    console.error("/api/students", e);
    res.status(500).json({ error: e.message });
  }
};
