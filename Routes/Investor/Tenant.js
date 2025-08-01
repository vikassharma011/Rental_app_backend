import express from "express";
import dotenv from "dotenv";
import { db } from "../../db.js";
import { authenticateInvestor } from "../../middlewares/authenticateInvestor.js";
import jwt from "jsonwebtoken";

const router = express.Router();

dotenv.config();

// GET tenants
router.get("/tenant", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ message: "Authorization token missing or invalid" });
    }

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const userId = decoded.userId;

    let baseSQL = `
      SELECT u.user_id, u.first_name, u.last_name, u.email, u.phone,
             l.start_date, l.end_date, l.rent_amount, u.status, u.is_active
      FROM users u
      JOIN leases l ON u.user_id = l.tenant_id
      JOIN property p ON l.property_id = p.property_id
      WHERE p.investor_id = ?
    `;

    const params = [userId];

    if (req.query.search) {
      baseSQL += ` AND (u.first_name LIKE ? OR u.email LIKE ?)`;
      const searchTerm = `%${req.query.search}%`;
      params.push(searchTerm, searchTerm);
    }

    const [rows] = await db.execute(baseSQL, params);
    res.json(rows);
  } catch (err) {
    console.error("Fetch tenants error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});


// ✅ GET Tenant Requests (Inactive)
router.get("/tenant-requests", async (req, res) => {
  const [rows] = await db.execute(
    `SELECT user_id, first_name, last_name, email, phone FROM users 
     WHERE role = 'tenant' AND is_active = false`
  );
  res.json(rows);
});


// ✅ Approve or Reject Tenant
router.patch("/tenant-requests/:id/:action", async (req, res) => {
  const { id, action } = req.params;
  if (action === "approve") {
    await db.execute(`UPDATE users SET is_active = true, status = 'approved' WHERE user_id = ?`, [id]);
  } else {
    await db.execute(`DELETE FROM users WHERE user_id = ? AND role = 'tenant'`, [id]);
  }
  res.json({ success: true, action });
});

// ✅ Add Tenant to Lease
router.post("/tenant", async (req, res) => {
  const { tenant_id, property_id, lease_start, lease_end, rent_amount } = req.body;
  await db.execute(
    `INSERT INTO leases (tenant_id, property_id, start_date, end_date, rent_amount, due_date, late_fee, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, 0, NOW(), NOW())`,
    [tenant_id, property_id, lease_start, lease_end, rent_amount]
  );
  await db.execute(`UPDATE users SET is_active = true WHERE user_id = ?`, [tenant_id]);
  res.status(201).json({ success: true });
});

// ✅ Toggle Tenant Active Status
router.patch("/tenant/:id/status", async (req, res) => {
  const { is_active } = req.body;
  const { id } = req.params;
  await db.execute(`UPDATE users SET is_active = ? WHERE user_id = ?`, [is_active, id]);
  res.json({ success: true });
});

router.get("/properties", authenticateInvestor, async (req, res) => {
  const investorId = req.user.userId;

  const [rows] = await db.execute(
    `SELECT property_id, title, address, city, state 
     FROM property 
     WHERE investor_id = ?`,
    [investorId]
  );

  res.json(rows);
});

export { router as TenantRouter };
