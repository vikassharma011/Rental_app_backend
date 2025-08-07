import express from "express";
import { db } from "../../db.js";
const router = express.Router();

// Upload a document (investor uploads, tenant/supplier can view)
router.post("/upload", async (req, res) => {
  try {
    const { property_id, uploaded_by, role, file_url, doc_type, visible_to_tenant, visible_to_supplier } = req.body;
    if (!uploaded_by || !role || !file_url || !doc_type) return res.status(400).json({ error: "Missing required fields" });
    const [result] = await db.execute(
      `INSERT INTO documents (property_id, uploaded_by, role, file_url, doc_type, visible_to_tenant, visible_to_supplier) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [property_id || null, uploaded_by, role, file_url, doc_type, visible_to_tenant || 1, visible_to_supplier || 0]
    );
    res.status(201).json({ message: "Document uploaded", id: result.insertId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get documents for a property (with access control)
router.get("/property/:id", async (req, res) => {
  try {
    const property_id = req.params.id;
    const { role } = req.query;
    let query = "SELECT * FROM documents WHERE property_id = ?";
    let params = [property_id];
    if (role === "tenant") query += " AND visible_to_tenant = 1";
    if (role === "supplier") query += " AND visible_to_supplier = 1";
    const [docs] = await db.execute(query, params);
    res.json({ documents: docs });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all documents uploaded by a user
router.get("/uploaded/:id", async (req, res) => {
  try {
    const user_id = req.params.id;
    const [docs] = await db.execute(
      `SELECT * FROM documents WHERE uploaded_by = ?`,
      [user_id]
    );
    res.json({ documents: docs });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export { router as DocumentsRouter };
