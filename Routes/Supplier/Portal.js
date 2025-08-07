import express from "express";
import { db } from "../../db.js";
const router = express.Router();

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
router.get("/communication/inbox/:id", async (req, res) => {
  try {
    const supplier_id = req.params.id;
    const [messages] = await db.execute("SELECT * FROM messages WHERE receiver_id = ?", [supplier_id]);
    res.json({ messages });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/communication/sent/:id", async (req, res) => {
  try {
    const supplier_id = req.params.id;
    const [messages] = await db.execute("SELECT * FROM messages WHERE sender_id = ?", [supplier_id]);
    res.json({ messages });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Send a message (supplier, tenant, investor)
router.post("/communication/send", async (req, res) => {
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
