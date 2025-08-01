import express from "express";
import dotenv from "dotenv";
import { db } from "../../db.js";
import jwt from "jsonwebtoken";

const router = express.Router();

dotenv.config();

// GET tenants
router.get("/tenant", async (req, res) => {
  try {
    const authHeader = req.headers.Authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ message: "Authorization token missing or invalid" });
    }

    const token = authHeader.split(" ")[1];

    const decoded = jwt.verify(token, process.env.JWT_SECRET); // Make sure JWT_SECRET is in your .env
    const userId = decoded.userId;

    let baseSQL = `
      SELECT u.user_id, u.first_name, u.last_name, u.email, u.phone,
             l.start_date, l.end_date, l.rent_amount, u.is_active
      FROM users u
      JOIN leases l ON u.user_id = l.tenant_id
      JOIN property p ON l.property_id = p.property_id
      WHERE p.investor_id = ? AND l.end_date >= CURRENT_DATE
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


// GET tenant requests
router.get("/tenant-requests", async (req, res) => {
  const investorId = req.user.userId;
  const [rows] = await db.execute(
    `SELECT u.user_id, u.first_name, u.last_name, u.email, u.phone
       FROM users u
       WHERE u.role = 'tenant' AND u.is_active = false`,
    []
  );
  res.json(rows);
});

// POST approve/reject
router.post("/tenant-requests/:id/:action", async (req, res) => {
  const { id, action } = req.params;
  if (action === "approve") {
    await db.execute(`UPDATE users SET is_active = true WHERE user_id = ?`, [id]);
  } else {
    await db.execute(`DELETE FROM users WHERE user_id = ? AND role = 'tenant'`, [id]);
  }
  res.json({ success: true, action });
});

// POST add tenant
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

// PATCH status
router.patch("/tenant/:id/status", async (req, res) => {
  const { is_active } = req.body;
  const { id } = req.params;
  await db.execute(`UPDATE users SET is_active = ? WHERE user_id = ?`, [is_active, id]);
  res.json({ success: true });
});

// GET properties
router.get("/properties", async (req, res) => {
  const investorId = req.user.userId;
  const [rows] = await db.execute(
    `SELECT property_id, address, city, state FROM properties WHERE investor_id = ?`,
    [investorId]
  );
  res.json(rows);
});

export { router as TenantRouter };
