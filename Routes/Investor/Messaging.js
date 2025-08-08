
import express from "express";
import { db } from "../../db.js";
const router = express.Router();


// Get contacts for investor messaging
// Get contacts for investor messaging (active tenants and suppliers, with search)
router.get('/contacts/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    const search = req.query.search ? `%${req.query.search}%` : null;

    // Tenants linked to investor's properties
    let tenantSQL = `
      SELECT u.user_id AS id, CONCAT(u.first_name, ' ', u.last_name) AS name, 'tenant' AS role
      FROM users u
      JOIN leases l ON u.user_id = l.tenant_id
      JOIN property p ON l.property_id = p.property_id
      WHERE p.investor_id = ? AND u.is_active = 1
    `;
    let tenantParams = [userId];
    if (search) {
      tenantSQL += ' AND (u.first_name LIKE ? OR u.last_name LIKE ? OR u.email LIKE ?)';
      tenantParams.push(search, search, search);
    }
    const [tenants] = await db.execute(tenantSQL, tenantParams);

    // Suppliers linked to investor (via property or maintenance)
    let supplierSQL = `
      SELECT DISTINCT u.user_id AS id, CONCAT(u.first_name, ' ', u.last_name) AS name, 'supplier' AS role
      FROM users u
      JOIN maintenance_requests m ON u.user_id = m.supplier_id
      JOIN property p ON m.property_id = p.property_id
      WHERE p.investor_id = ? AND u.is_active = 1
    `;
    let supplierParams = [userId];
    if (search) {
      supplierSQL += ' AND (u.first_name LIKE ? OR u.last_name LIKE ? OR u.email LIKE ?)';
      supplierParams.push(search, search, search);
    }
    const [suppliers] = await db.execute(supplierSQL, supplierParams);

    const contacts = [...tenants, ...suppliers];
    res.json({ contacts });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Send a message (investor, tenant, supplier)
router.post("/send", async (req, res) => {
  try {
    const { sender_id, receiver_id, role, content } = req.body;
    if (!sender_id || !receiver_id || !role || !content) return res.status(400).json({ error: "Missing required fields" });
    const [result] = await db.execute(
      `INSERT INTO messages (sender_id, receiver_id, role, content) VALUES (?, ?, ?, ?)`,
      [sender_id, receiver_id, role, content]
    );
    res.status(201).json({ message: "Message sent", id: result.insertId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get messages for a user (inbox)
router.get("/inbox/:id", async (req, res) => {
  try {
    const user_id = req.params.id;
    const [messages] = await db.execute(
      `SELECT * FROM messages WHERE receiver_id = ? ORDER BY created_at DESC`,
      [user_id]
    );
    res.json({ messages });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get messages sent by a user (sent)
router.get("/sent/:id", async (req, res) => {
  try {
    const user_id = req.params.id;
    const [messages] = await db.execute(
      `SELECT * FROM messages WHERE sender_id = ? ORDER BY created_at DESC`,
      [user_id]
    );
    res.json({ messages });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export { router as MessagingRouter };
