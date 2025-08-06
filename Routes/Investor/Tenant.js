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
router.post("/tenant-requests/:id/:action", async (req, res) => {
  const { id, action } = req.params;
  // Fetch tenant info
  const [rows] = await db.execute(`SELECT email, first_name FROM users WHERE user_id = ? AND role = 'tenant'`, [id]);
  const tenant = rows[0];
  let emailSent = false;
  if (action === "approve") {
    await db.execute(`UPDATE users SET is_active = true, status = 'approved' WHERE user_id = ?`, [id]);
    if (tenant?.email) {
      try {
        await sendEmail(
          tenant.email,
          "Account Approved",
          `🎉 Hi ${tenant.first_name}, your account has been approved!\nLogin here: https://yourapp.com/tenant/login`
        );
        emailSent = true;
      } catch (err) {
        console.error("Failed to send approval email:", err.message);
      }
    }
  } else {
    if (tenant?.email) {
      try {
        await sendEmail(
          tenant.email,
          "Account Rejected",
          `❌ Sorry, your account has been rejected.`
        );
        emailSent = true;
      } catch (err) {
        console.error("Failed to send rejection email:", err.message);
      }
    }
    await db.execute(`DELETE FROM users WHERE user_id = ? AND role = 'tenant'`, [id]);
  }
  res.json({ success: true, action, emailSent });
});

// ✅ Add Tenant to Lease
router.post("/tenant", async (req, res) => {
  const { tenant_id, property_id, lease_start, lease_end, rent_amount } = req.body;

  try {
    // Step 1: Check if a lease already exists for this tenant
    const [existingLease] = await db.execute(
      `SELECT * FROM leases WHERE tenant_id = ?`,
      [tenant_id]
    );

    if (existingLease.length > 0) {
      // Step 2: If lease exists, update it
      await db.execute(
        `UPDATE leases 
         SET property_id = ?, start_date = ?, end_date = ?, rent_amount = ?, updated_at = NOW()
         WHERE tenant_id = ?`,
        [property_id, lease_start, lease_end, rent_amount, tenant_id]
      );
    } else {
      // Step 3: If no lease exists, insert new
      await db.execute(
        `INSERT INTO leases (tenant_id, property_id, start_date, end_date, rent_amount, due_date, late_fee, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, 0, NOW(), NOW())`,
        [tenant_id, property_id, lease_start, lease_end, rent_amount]
      );
    }

    // Step 4: Update user status to active
    await db.execute(`UPDATE users SET is_active = true WHERE user_id = ?`, [tenant_id]);

    res.status(201).json({ success: true });
  } catch (error) {
    console.error("Error adding/updating tenant lease:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});


// ✅ Toggle Tenant Active Status
router.put("/tenant/:id/status", async (req, res) => {
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

// ✅ Get a Single Tenant by ID
router.get("/tenant/:id", async (req, res) => {
  try {
    const tenantId = req.params.id;

    const [rows] = await db.execute(
      `SELECT 
        u.user_id,
        u.first_name,
        u.last_name,
        u.email,
        u.phone,
        u.status,
        u.is_active,
        l.start_date AS lease_start,
        l.end_date AS lease_end,
        l.rent_amount,
        p.title AS property_name,
        p.address AS property_address
      FROM users u
      JOIN leases l ON u.user_id = l.tenant_id
      JOIN property p ON l.property_id = p.property_id
      WHERE u.user_id = ?
      LIMIT 1`,
      [tenantId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Tenant not found" });
    }

    const tenant = rows[0];

    res.json({
      user_id: tenant.user_id,
      name: `${tenant.first_name} ${tenant.last_name}`,
      email: tenant.email,
      phone: tenant.phone,
      status: tenant.status,
      is_active: tenant.is_active,
      leaseStart: tenant.lease_start,
      leaseEnd: tenant.lease_end,
      rentDue: tenant.rent_amount,
      property: tenant.property_name,
      address: tenant.property_address,
      profileImage: `https://api.dicebear.com/7.x/thumbs/svg?seed=${tenant.user_id}`
    });
  } catch (error) {
    console.error("Error fetching tenant by ID:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// GET /tenant/available-tenants
router.get("/available-tenants", authenticateInvestor, async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT * FROM users
      WHERE role = 'tenant'
      AND user_id NOT IN (
        SELECT tenant_id FROM leases WHERE CURRENT_DATE BETWEEN start_date AND end_date
      )
    `);
    res.json(rows);
  } catch (err) {
    console.error("❌ Fetch tenants error:", err);
    res.status(500).json({ error: "Failed to fetch available tenants" });
  }
});




export { router as TenantRouter };
