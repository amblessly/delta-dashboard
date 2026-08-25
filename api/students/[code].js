/* GET /api/students/:code — student profile by sequential Student ID. */
const { pool } = require("../_db.js");
const lib = require("../../_lib.js");

module.exports = async (req, res) => {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const result = await lib.getStudentByCode(pool(), req.query.code);
    if (result.error) return res.status(400).json(result);
    if (result.notFound) return res.status(404).json({ error: "Student not found" });
    res.status(200).json(result.student);
  } catch (e) {
    console.error("/api/students/:code", e);
    res.status(500).json({ error: e.message });
  }
};
