/* POST /api/students/enroll — register a new student.
   Body: { name, dateOfBirth?, weightKg? }
   The sequential Student ID is assigned by the database (starts at 101). */
const { pool } = require("./_db.js");
const lib = require("../_lib.js");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const b = req.body || {};
  try {
    const result = await lib.enrollStudent(pool(), {
      name: b.name,
      dateOfBirth: b.dateOfBirth,
      weightKg: b.weightKg,
    });
    if (result.error) return res.status(400).json(result);
    res.status(201).json(result.student);
  } catch (e) {
    console.error("/api/students/enroll", e);
    res.status(500).json({ error: e.message });
  }
};
