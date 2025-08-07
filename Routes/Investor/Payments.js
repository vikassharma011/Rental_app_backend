import express from "express";
import { db } from "../../db.js";
const router = express.Router();

// Add a payment (rent, maintenance, supplier)
router.post("/add", async (req, res) => {
  try {
    const { lease_id, tenant_id, supplier_id, amount, payment_type } = req.body;
    if (!amount || !payment_type) return res.status(400).json({ error: "Missing required fields" });
    const [result] = await db.execute(
      `INSERT INTO payments (lease_id, tenant_id, supplier_id, amount, payment_type, status) VALUES (?, ?, ?, ?, ?, 'pending')`,
      [lease_id || null, tenant_id || null, supplier_id || null, amount, payment_type]
    );
    res.status(201).json({ message: "Payment created", id: result.insertId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Calculate late fee for tenant rent payment
router.get("/latefee/:tenant_id", async (req, res) => {
  try {
    const tenant_id = req.params.tenant_id;
    // Get lease info
    const [[lease]] = await db.execute("SELECT * FROM leases WHERE tenant_id = ? ORDER BY start_date DESC LIMIT 1", [tenant_id]);
    if (!lease) return res.json({ late_fee: 0 });
    // Check if rent is overdue
    const today = new Date();
    const dueDate = new Date(lease.start_date);
    dueDate.setDate(lease.due_date);
    let late_fee = 0;
    if (today > dueDate) late_fee = lease.late_fee;
    res.json({ late_fee });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Transfer payment to supplier (by investor)
router.post("/transfer", async (req, res) => {
  try {
    const { supplier_id, amount } = req.body;
    if (!supplier_id || !amount) return res.status(400).json({ error: "Missing required fields" });
    const [result] = await db.execute(
      `INSERT INTO payments (supplier_id, amount, payment_type, status) VALUES (?, ?, 'supplier', 'pending')`,
      [supplier_id, amount]
    );
    res.status(201).json({ message: "Supplier payment initiated", id: result.insertId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get payments by user (tenant or supplier)
router.get("/user/:id", async (req, res) => {
  try {
    const user_id = req.params.id;
    const [payments] = await db.execute(
      `SELECT * FROM payments WHERE tenant_id = ? OR supplier_id = ?`,
      [user_id, user_id]
    );
    res.json({ payments });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update payment status
router.put("/:id/status", async (req, res) => {
  try {
    const payment_id = req.params.id;
    const { status } = req.body;
    await db.execute(
      `UPDATE payments SET status = ?, updated_at = NOW() WHERE payment_id = ?`,
      [status, payment_id]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all payments (admin/investor)
router.get("/all", async (req, res) => {
  try {
    const [payments] = await db.execute(`SELECT * FROM payments`);
    res.json({ payments });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export { router as PaymentsRouter };
