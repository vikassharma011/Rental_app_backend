import express from "express";
import { db } from "../../db.js";
import jwt from "jsonwebtoken";
const router = express.Router();

// Authentication middleware
const authenticateUser = (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) {
      return res.status(401).json({ error: "No token provided" });
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: "Invalid token" });
  }
};

// Get all documents for investor
router.get("/documents", authenticateUser, async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT 
        d.*,
        p.title as property_title,
        u.first_name as uploaded_by_name,
        u.last_name as uploaded_by_lastname
      FROM documents d
      LEFT JOIN property p ON d.property_id = p.property_id
      LEFT JOIN users u ON d.uploaded_by = u.user_id
      WHERE p.investor_id = ? OR d.uploaded_by = ?
      ORDER BY d.created_at DESC
    `, [req.user.userId, req.user.userId]);
    
    res.json({ documents: rows });
  } catch (err) {
    console.error("Error fetching documents:", err);
    res.status(500).json({ error: err.message });
  }
});

// Upload new document
router.post("/documents", authenticateUser, async (req, res) => {
  try {
    const { property_id, file_name, doc_type, file_url, visible_to_tenant, visible_to_supplier } = req.body;
    
    if (!property_id || !file_name || !doc_type) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const [result] = await db.execute(`
      INSERT INTO documents (property_id, uploaded_by, role, file_url, doc_type, visible_to_tenant, visible_to_supplier, created_at)
      VALUES (?, ?, 'investor', ?, ?, ?, ?, NOW())
    `, [property_id, req.user.userId, file_url || file_name, doc_type, visible_to_tenant ? 1 : 0, visible_to_supplier ? 1 : 0]);
    
    res.status(201).json({ 
      message: "Document uploaded successfully", 
      document_id: result.insertId 
    });
  } catch (err) {
    console.error("Error uploading document:", err);
    res.status(500).json({ error: err.message });
  }
});

// Delete document
router.delete("/documents/:id", authenticateUser, async (req, res) => {
  try {
    const [result] = await db.execute(`
      DELETE d FROM documents d
      LEFT JOIN property p ON d.property_id = p.property_id
      WHERE d.document_id = ? AND (p.investor_id = ? OR d.uploaded_by = ?)
    `, [req.params.id, req.user.userId, req.user.userId]);
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Document not found or unauthorized" });
    }
    
    res.json({ message: "Document deleted successfully" });
  } catch (err) {
    console.error("Error deleting document:", err);
    res.status(500).json({ error: err.message });
  }
});

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
