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
        d.document_id,
        d.document_name,
        d.doc_type,
        d.file_url,
        d.created_at,
        d.visible_to_tenant,
        d.visible_to_supplier,
        p.title as property_title,
        p.property_id
      FROM documents d
      LEFT JOIN property p ON d.property_id = p.property_id
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
    const { property_id, document_name, doc_type, file_url, visible_to_tenant, visible_to_supplier } = req.body;
    
    if (!property_id || !document_name || !doc_type || !file_url) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const [result] = await db.execute(`
      INSERT INTO documents 
      (property_id, uploaded_by, role, document_name, file_url, doc_type, visible_to_tenant, visible_to_supplier)
      VALUES (?, ?, 'investor', ?, ?, ?, ?, ?)
    `, [
      property_id,
      req.user.userId,
      document_name,
      file_url,
      doc_type,
      visible_to_tenant ? 1 : 0,
      visible_to_supplier ? 1 : 0
    ]);
    
    res.status(201).json({ 
      message: "Document uploaded successfully", 
      document_id: result.insertId 
    });

  } catch (err) {
    console.error("Error uploading document:", err);
    res.status(500).json({ error: err.message });
  }
});

// Update a document
router.put("/documents/:id", authenticateUser, async (req, res) => {
  try {
    const { document_name, doc_type, property_id, visible_to_tenant, visible_to_supplier } = req.body;
    const document_id = req.params.id;

    if (!document_name || !doc_type || !property_id) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const [result] = await db.execute(`
      UPDATE documents
      SET 
        document_name = ?, 
        doc_type = ?, 
        property_id = ?, 
        visible_to_tenant = ?, 
        visible_to_supplier = ?
      WHERE document_id = ? 
      AND uploaded_by = ?
    `, [
      document_name,
      doc_type,
      property_id,
      visible_to_tenant ? 1 : 0,
      visible_to_supplier ? 1 : 0,
      document_id,
      req.user.userId
    ]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Document not found or unauthorized" });
    }

    res.json({ message: "Document updated successfully" });
  } catch (err) {
    console.error("Error updating document:", err);
    res.status(500).json({ error: err.message });
  }
});

// Delete document
router.delete("/documents/:id", authenticateUser, async (req, res) => {
  try {
    const [result] = await db.execute(`
      DELETE FROM documents
      WHERE document_id = ? AND uploaded_by = ?
    `, [req.params.id, req.user.userId]);
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Document not found or unauthorized" });
    }
    
    res.json({ message: "Document deleted successfully" });
  } catch (err) {
    console.error("Error deleting document:", err);
    res.status(500).json({ error: err.message });
  }
});

export { router as DocumentsRouter };