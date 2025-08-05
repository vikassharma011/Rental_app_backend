import express from "express";
import { db } from "../../db.js";
const router = express.Router();

// Get all suppliers
router.get("/suppliers", async (req, res) => {
  try {
    // Get all suppliers
    const [suppliers] = await db.execute("SELECT * FROM users WHERE role = 'supplier'");
    // For each supplier, get completed tasks and avg response time
    const results = await Promise.all(suppliers.map(async (sup) => {
      // Completed tasks: maintenance_requests where supplier_id = sup.user_id and status = 'completed'
      const [[{ completedTasks }]] = await db.execute(
        "SELECT COUNT(*) AS completedTasks FROM maintenance_requests WHERE supplier_id = ? AND status = 'completed'",
        [sup.user_id]
      );
      // Avg response time: average hours between created_at and updated_at for completed tasks
      const [[{ avgResponseTime }]] = await db.execute(
        `SELECT AVG(TIMESTAMPDIFF(HOUR, created_at, updated_at)) AS avgResponseTime FROM maintenance_requests WHERE supplier_id = ? AND status = 'completed'`,
        [sup.user_id]
      );
      return {
        ...sup,
        completedTasks: completedTasks || 0,
        avgResponseTime: avgResponseTime !== null ? Number(avgResponseTime).toFixed(1) : null
      };
    }));
    res.json(results);
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
