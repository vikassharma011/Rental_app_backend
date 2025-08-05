import express from "express";
import { db } from "../../db.js";
const router = express.Router();

// Get all suppliers
router.get("/suppliers", async (req, res) => {
  try {
    const [rows] = await db.execute("SELECT * FROM users WHERE role = 'supplier'");
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Approve supplier join request
router.put("/suppliers/:id/approve", async (req, res) => {
  try {
    await db.execute("UPDATE users SET status = 'approved' WHERE user_id = ?", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reject supplier join request
router.put("/suppliers/:id/reject", async (req, res) => {
  try {
    await db.execute("UPDATE users SET status = 'rejected' WHERE user_id = ?", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Toggle supplier active/inactive
router.put("/suppliers/:id/toggle", async (req, res) => {
  try {
    await db.execute("UPDATE users SET is_active = NOT is_active WHERE user_id = ?", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export { router as SupplierRouter };
