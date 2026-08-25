/* POST /api/students/enroll — register a new student with a face reference.
   Body: { name, descriptor:[128 floats], dateOfBirth?, weightKg?, photo? }
   The sequential Student ID is assigned by the database (starts at 101).
   A face that is already registered returns 409 with the existing student. */
const { pool } = require("./_db.js");
const lib = require("../_lib.js");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const b = req.body || {};
  try {
    const result = await lib.enrollStudent(pool(), {
      name: b.name,
      descriptor: b.descriptor,
      dateOfBirth: b.dateOfBirth,
      weightKg: b.weightKg,
      photo: b.photo,
    });
    if (result.error) return res.status(400).json(result);
    if (result.conflict) {
      return res.status(409).json({
        error: "This face is already registered.",
        student: result.student,
      });
    }
    res.status(201).json(result.student);
  } catch (e) {
    console.error("/api/students/enroll", e);
    res.status(500).json({ error: e.message });
  }
};
