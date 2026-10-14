/* GET /api/students - all students with their face embeddings */
const { pool } = require("./_db.js");

module.exports = async (req, res) => {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const students = await pool().query("SELECT id, name, age, weight_kg FROM students ORDER BY id");
    const embs = await pool().query("SELECT student_id, embedding FROM face_embeddings ORDER BY id");
    const byStudent = {};
    for (const e of embs.rows) {
      (byStudent[e.student_id] = byStudent[e.student_id] || []).push(e.embedding);
    }
    res.status(200).json(students.rows.map(s => ({
      ...s,
      embeddings: byStudent[s.id] || [],
    })));
  } catch (e) {
    console.error("/api/students", e);
    res.status(500).json({ error: e.message });
  }
};