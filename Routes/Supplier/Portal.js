
import express from "express";
import { db } from "../../db.js";
import jwt from "jsonwebtoken";
const router = express.Router();

// Simple authentication middleware for supplier
function authenticateSupplier(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ success: false });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== "supplier") {
      return res.status(403).json({ success: false, message: "Only suppliers allowed" });
    }
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ success: false, message: "Invalid token" });
  }
}


// Get contacts for supplier messaging (investors and tenants linked to supplier)
router.get('/contacts/:userId', authenticateSupplier, async (req, res) => {
  try {
    const userId = req.params.userId;
    const search = req.query.search ? `%${req.query.search}%` : null;

    // Get investors for properties supplier worked on
    let investorSQL = `
      SELECT DISTINCT i.user_id AS id, CONCAT(i.first_name, ' ', i.last_name) AS name, 'investor' AS role
      FROM users i
      JOIN property p ON i.user_id = p.investor_id
      JOIN maintenance_requests m ON p.property_id = m.property_id
      WHERE m.supplier_id = ? AND i.is_active = 1
    `;
    let investorParams = [userId];
    if (search) {
      investorSQL += ' AND (i.first_name LIKE ? OR i.last_name LIKE ? OR i.email LIKE ?)';
      investorParams.push(search, search, search);
    }
    const [investors] = await db.execute(investorSQL, investorParams);

    // Get tenants for properties supplier worked on
    let tenantSQL = `
      SELECT DISTINCT t.user_id AS id, CONCAT(t.first_name, ' ', t.last_name) AS name, 'tenant' AS role
      FROM users t
      JOIN leases l ON t.user_id = l.tenant_id
      JOIN maintenance_requests m ON l.property_id = m.property_id
      WHERE m.supplier_id = ? AND t.is_active = 1
    `;
    let tenantParams = [userId];
    if (search) {
      tenantSQL += ' AND (t.first_name LIKE ? OR t.last_name LIKE ? OR t.email LIKE ?)';
      tenantParams.push(search, search, search);
    }
    const [tenants] = await db.execute(tenantSQL, tenantParams);

    const contacts = [...investors, ...tenants];
    res.json({ contacts });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Dashboard summary for supplier
router.get("/dashboard/:id", async (req, res) => {
  try {
    const supplier_id = req.params.id;
    // Assigned tasks, earnings, inventory
    const [tasks] = await db.execute("SELECT * FROM maintenance_requests WHERE supplier_id = ? AND status != 'completed'", [supplier_id]);
    const [earnings] = await db.execute("SELECT SUM(amount) as total_earnings FROM payments WHERE supplier_id = ? AND status = 'completed'", [supplier_id]);
    const [inventory] = await db.execute("SELECT * FROM inventory_items WHERE supplier_id = ?", [supplier_id]);
    res.json({ tasks, earnings: earnings[0]?.total_earnings || 0, inventory });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get/update supplier profile
router.get("/profile/:id", async (req, res) => {
  try {
    const supplier_id = req.params.id;
    const [[profile]] = await db.execute("SELECT * FROM users WHERE user_id = ? AND role = 'supplier'", [supplier_id]);
    res.json({ profile });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put("/profile/:id", async (req, res) => {
  try {
    const supplier_id = req.params.id;
    const { first_name, last_name, phone } = req.body;
    await db.execute("UPDATE users SET first_name = ?, last_name = ?, phone = ? WHERE user_id = ? AND role = 'supplier'", [first_name, last_name, phone, supplier_id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Tasks (assigned)
router.get("/tasks/:id", async (req, res) => {
  try {
    const supplier_id = req.params.id;
    const [tasks] = await db.execute("SELECT * FROM maintenance_requests WHERE supplier_id = ?", [supplier_id]);
    res.json({ tasks });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Work history (completed tasks)
router.get("/work-history/:id", async (req, res) => {
  try {
    const supplier_id = req.params.id;
    const [history] = await db.execute("SELECT * FROM maintenance_requests WHERE supplier_id = ? AND status = 'completed'", [supplier_id]);
    res.json({ history });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Inventory supplied
router.get("/inventory/:id", async (req, res) => {
  try {
    const supplier_id = req.params.id;
    const [items] = await db.execute("SELECT * FROM inventory_items WHERE supplier_id = ?", [supplier_id]);
    res.json({ items });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Earnings/payments
router.get("/earnings/:id", async (req, res) => {
  try {
    const supplier_id = req.params.id;
    const [payments] = await db.execute("SELECT * FROM payments WHERE supplier_id = ? AND status = 'completed'", [supplier_id]);
    res.json({ payments });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Notifications (assigned tasks, payment status)
router.get("/notifications/:id", async (req, res) => {
  try {
    const supplier_id = req.params.id;
    // New assigned tasks
    const [tasks] = await db.execute("SELECT * FROM maintenance_requests WHERE supplier_id = ? AND status IN ('assigned','in_progress')", [supplier_id]);
    // Payment status
    const [pending] = await db.execute("SELECT * FROM payments WHERE supplier_id = ? AND status = 'pending'", [supplier_id]);
    res.json({ notifications: { tasks, pending_payments: pending } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Settings update
router.put("/settings/:id", async (req, res) => {
  try {
    const supplier_id = req.params.id;
    const { is_active } = req.body;
    await db.execute("UPDATE users SET is_active = ? WHERE user_id = ? AND role = 'supplier'", [is_active, supplier_id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Communication (messaging)
router.get("/communication/inbox/:id", authenticateSupplier, async (req, res) => {
  try {
    const supplier_id = req.params.id;
    const [messages] = await db.execute("SELECT * FROM messages WHERE receiver_id = ?", [supplier_id]);
    res.json({ messages });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/communication/sent/:id", authenticateSupplier, async (req, res) => {
  try {
    const supplier_id = req.params.id;
    const [messages] = await db.execute("SELECT * FROM messages WHERE sender_id = ?", [supplier_id]);
    res.json({ messages });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Send a message (supplier, tenant, investor)
router.post("/communication/send", authenticateSupplier, async (req, res) => {
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

export { router as SupplierPortalRouter };
