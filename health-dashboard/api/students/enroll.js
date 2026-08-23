/* POST /api/students/enroll - enroll a face embedding for a student */
const { pool } = require("./_db.js");

const num = v => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const b = req.body;
  const name = typeof b.name === "string" ? b.name.trim().slice(0, 120) : "";
  const emb = Array.isArray(b.embedding)
    ? b.embedding.slice(0, 128).map(v => Number(v))
    : [];
  if (!name || emb.length !== 128 || emb.some(v => !Number.isFinite(v))) {
    return res.status(400).json({ error: "name and 128-float embedding required" });
  }
  try {
    let student = await pool().query(
      "SELECT id, name, age, weight_kg FROM students WHERE lower(name) = lower($1)",
      [name]
    );
    if (student.rowCount === 0) {
      student = await pool().query(
        "INSERT INTO students (name, age, weight_kg) VALUES ($1, $2, $3) RETURNING id, name, age, weight_kg",
        [name, num(b.age), num(b.weightKg)]
      );
    } else {
      /* Update age/weight if provided */
      const updates = [];
      const params = [name];
      if (num(b.age) != null) {
        updates.push("age = $" + (params.length + 1));
        params.push(num(b.age));
      }
      if (num(b.weightKg) != null) {
        updates.push("weight_kg = $" + (params.length + 1));
        params.push(num(b.weightKg));
      }
      if (updates.length > 0) {
        await pool().query(
          "UPDATE students SET " + updates.join(", ") + " WHERE lower(name) = lower($1)",
          params
        );
        student = await pool().query("SELECT id, name, age, weight_kg FROM students WHERE lower(name) = lower($1)", [name]);
      }
    }
    const sid = student.rows[0].id;
    await pool().query(
      "INSERT INTO face_embeddings (student_id, embedding) VALUES ($1, $2)",
      [sid, emb]
    );
    res.status(201).json({ ...student.rows[0], enrolled: true });
  } catch (e) {
    console.error("/api/students/enroll", e);
    res.status(500).json({ error: e.message });
  }
};