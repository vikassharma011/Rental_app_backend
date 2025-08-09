
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

// Get all maintenance requests for investor
router.get("/requests", authenticateUser, async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT 
        mr.*,
        u.first_name as tenant_first_name,
        u.last_name as tenant_last_name,
        p.title as property_title,
        p.address as property_address,
        sup.first_name as supplier_first_name,
        sup.last_name as supplier_last_name,
        mq.amount as quote_amount,
        mq.status as quote_status,
        mq.payment_status
      FROM maintenance_requests mr
      LEFT JOIN users u ON mr.tenant_id = u.user_id
      LEFT JOIN property p ON mr.property_id = p.property_id
      LEFT JOIN users sup ON mr.supplier_id = sup.user_id
      LEFT JOIN maintenance_quotes mq ON mr.request_id = mq.request_id AND mq.status = 'accepted'
      WHERE p.investor_id = ?
      ORDER BY mr.created_at DESC
    `, [req.user.userId]);
    
    res.json({ requests: rows });
  } catch (err) {
    console.error("Error fetching maintenance requests:", err);
    res.status(500).json({ error: err.message });
  }
});

// Get completed maintenance requests for supplier payments
router.get("/completed-requests", authenticateUser, async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT 
        mr.*,
        u.first_name as tenant_first_name,
        u.last_name as tenant_last_name,
        p.title as property_title,
        sup.first_name as supplier_first_name,
        sup.last_name as supplier_last_name,
        mq.quote_id,
        mq.amount as quote_amount,
        mq.status as quote_status,
        mq.payment_status
      FROM maintenance_requests mr
      LEFT JOIN users u ON mr.tenant_id = u.user_id
      LEFT JOIN property p ON mr.property_id = p.property_id
      LEFT JOIN users sup ON mr.supplier_id = sup.user_id
      LEFT JOIN maintenance_quotes mq ON mr.request_id = mq.request_id 
      WHERE mr.status = 'completed' AND mq.status = 'accepted'
      ORDER BY mr.updated_at DESC
    `, []);
    
    res.json({ requests: rows });
  } catch (err) {
    console.error("Error fetching completed requests:", err);
    res.status(500).json({ error: err.message });
  }
});

// Update maintenance request status
router.put("/requests/:id/status", authenticateUser, async (req, res) => {
  try {
    const { status, supplier_id } = req.body;
    
    await db.execute(`
      UPDATE maintenance_requests 
      SET status = ?, supplier_id = ?, updated_at = NOW() 
      WHERE request_id = ?
    `, [status, supplier_id || null, req.params.id]);
    
    res.json({ success: true });
  } catch (err) {
    console.error("Error updating request status:", err);
    res.status(500).json({ error: err.message });
  }
});


// Delete a maintenance request
router.delete("/requests/:id", async (req, res) => {
  try {
    // Optionally, delete related quotes first if you want to enforce referential integrity
    await db.execute("DELETE FROM maintenance_quotes WHERE request_id = ?", [req.params.id]);
    const [result] = await db.execute("DELETE FROM maintenance_requests WHERE request_id = ?", [req.params.id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Request not found" });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// --- Supplier Quotes ---
// Get all quotes for a maintenance request
router.get("/requests/:id/quotes", async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT q.*, u.first_name, u.last_name FROM maintenance_quotes q
        LEFT JOIN users u ON q.supplier_id = u.user_id
        WHERE q.request_id = ?`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update priority
router.put("/requests/:id/priority", async (req, res) => {
  try {
    const { priority } = req.body;
    await db.execute(
      "UPDATE maintenance_requests SET priority = ?, updated_at = NOW() WHERE request_id = ?",
      [priority, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Supplier submits a quote for a maintenance request
router.post("/requests/:id/quotes", async (req, res) => {
  try {
    const { supplier_id, amount } = req.body;
    if (!supplier_id || !amount) return res.status(400).json({ error: "Missing supplier_id or amount" });
    await db.execute(
      `INSERT INTO maintenance_quotes (request_id, supplier_id, amount, status, created_at) VALUES (?, ?, ?, 'pending', NOW())`,
      [req.params.id, supplier_id, amount]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Investor accepts a supplier's quote for a maintenance request
router.put("/requests/:id/quotes/:quoteId/accept", async (req, res) => {
  try {
    // Mark all quotes as rejected except the accepted one
    await db.execute(
      `UPDATE maintenance_quotes SET status = 'rejected' WHERE request_id = ? AND quote_id != ?`,
      [req.params.id, req.params.quoteId]
    );
    // Mark the accepted quote
    await db.execute(
      `UPDATE maintenance_quotes SET status = 'accepted' WHERE quote_id = ?`,
      [req.params.quoteId]
    );
    // Update the maintenance request with the accepted supplier and quote
    const [[accepted]] = await db.execute(
      `SELECT supplier_id, amount FROM maintenance_quotes WHERE quote_id = ?`,
      [req.params.quoteId]
    );
    await db.execute(
      `UPDATE maintenance_requests SET supplier_id = ?, quote_amount = ?, status = 'assigned' WHERE request_id = ?`,
      [accepted.supplier_id, accepted.amount, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all maintenance requests
router.get("/requests", async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT mr.*, p.title AS property_title, p.image_url AS property_image,
        COALESCE(u.first_name, CONCAT_WS(' ', u.first_name, u.last_name), u.first_name, '') AS supplier_name
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
