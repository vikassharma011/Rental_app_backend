import express from "express" ; 
import { db } from "../../db.js";
import { authenticateInvestor } from "../../middlewares/authenticateInvestor.js";

const router = express.Router();

// ✅ GET /admin/tenants?search=...
router.get("/tenants", async (req, res) => {
  const search = req.query.search;
  try {
    const baseQuery = `
      SELECT u.user_id, u.first_name, u.last_name, u.email, u.phone,
             l.start_date, l.end_date, l.rent_amount, l.lease_id, u.is_active
        FROM users u
        JOIN leases l ON u.user_id = l.tenant_id
        WHERE u.role = 'tenant'
          AND l.end_date >= CURRENT_DATE
    `;
    const searchQuery = search ? ` AND (u.first_name LIKE ? OR u.email LIKE ?)` : "";
    const [rows] = await db.execute(baseQuery + searchQuery, search ? [`%${search}%`, `%${search}%`] : []);
    res.json(rows);
  } catch (error) {
    console.error("Tenant fetch error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ✅ GET /admin/tenants/:id
router.get("/tenants/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const [rows] = await db.execute(
      `SELECT u.*, l.*, p.address, p.city, p.state, p.zip_code
         FROM users u
         JOIN leases l ON u.user_id = l.tenant_id
         JOIN properties p ON l.property_id = p.property_id
         WHERE u.user_id = ?`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Tenant not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error("Tenant detail error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ✅ POST /admin/tenants — assign property to tenant
router.post("/tenants", async (req, res) => {
  const { tenant_id, property_id, lease_start, lease_end, rent_amount } = req.body;
  if (!tenant_id || !property_id) {
    return res.status(400).json({ error: "Missing tenant_id or property_id" });
  }
  try {
    const [result] = await db.execute(
      `INSERT INTO leases (
         tenant_id, property_id, start_date, end_date, rent_amount,
         due_date, late_fee, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 1, 0, NOW(), NOW())`,
      [tenant_id, property_id, lease_start, lease_end, rent_amount]
    );
    await db.execute(`UPDATE users SET is_active = true WHERE user_id = ?`, [tenant_id]);
    res.status(201).json({ lease_id: result.insertId });
  } catch (err) {
    console.error("Lease insert error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ✅ PATCH /admin/tenants/:id/status
router.patch("/tenants/:id/status", async (req, res) => {
  const { is_active } = req.body;
  const { id } = req.params;
  try {
    await db.execute(
      `UPDATE users SET is_active = ?, updated_at = NOW() WHERE user_id = ?`,
      [is_active, id]
    );
    res.json({ message: "Status updated" });
  } catch (err) {
    console.error("Status update error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ✅ GET /admin/tenant-requests
router.get("/tenant-requests", async (_req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT user_id, first_name, last_name, email, phone 
       FROM users 
       WHERE role = 'tenant' AND is_active = false`
    );
    res.json(rows);
  } catch (err) {
    console.error("Request fetch error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ✅ POST /admin/tenant-requests/:id/approve
router.post("/tenant-requests/:id/approve", async (req, res) => {
  const { id } = req.params;
  try {
    await db.execute(`UPDATE users SET is_active = false WHERE user_id = ?`, [id]);
    res.json({ message: "Approved; now assign property" });
  } catch (err) {
    console.error("Approval error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ✅ POST /admin/tenant-requests/:id/reject
router.post("/tenant-requests/:id/reject", async (req, res) => {
  const { id } = req.params;
  try {
    await db.execute(`DELETE FROM users WHERE user_id = ? AND role = 'tenant'`, [id]);
    res.json({ message: "Rejected and removed" });
  } catch (err) {
    console.error("Rejection error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export { router as TenantRouter };