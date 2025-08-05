import express from "express";
import { db } from "../../db.js";
const router = express.Router();

// Get all maintenance requests
router.get("/requests", async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT mr.*, p.title AS property_title, p.image_url AS property_image, u.first_name AS supplier_name
      FROM maintenance_requests mr
      LEFT JOIN property p ON mr.property_id = p.property_id
      LEFT JOIN users u ON mr.supplier_id = u.user_id
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a new maintenance request
router.post("/requests", async (req, res) => {
  try {
    const { property_id, tenant_id, issue_description, photo_url, priority } = req.body;
    const [result] = await db.execute(
      "INSERT INTO maintenance_requests (property_id, tenant_id, issue_description, photo_url, status, priority, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, NOW(), NOW())",
      [property_id, tenant_id, issue_description, photo_url, priority]
    );
    res.json({ request_id: result.insertId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Assign or reassign supplier
router.put("/requests/:id/assign", async (req, res) => {
  try {
    const { supplier_id } = req.body;
    await db.execute(
      "UPDATE maintenance_requests SET supplier_id = ?, status = 'assigned', updated_at = NOW() WHERE request_id = ?",
      [supplier_id, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update status (in_progress, completed, escalated)
router.put("/requests/:id/status", async (req, res) => {
  try {
    const { status } = req.body;
    await db.execute(
      "UPDATE maintenance_requests SET status = ?, updated_at = NOW() WHERE request_id = ?",
      [status, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single request details
router.get("/requests/:id", async (req, res) => {
  try {
    const [rows] = await db.execute("SELECT * FROM maintenance_requests WHERE request_id = ?", [req.params.id]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export { router as MaintenanceRouter };
