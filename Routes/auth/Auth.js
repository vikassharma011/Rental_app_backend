import express from "express";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import { db } from "../../db.js";
import { sendEmail } from "../../utils/sendEmail.js";
import { authenticateInvestor } from "../../middlewares/authenticateInvestor.js";

dotenv.config();

// Set default JWT_SECRET for local development
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-for-development';

const router = express.Router();

// ✅ GET PENDING USERS (for admin dashboard)
router.get("/pending-users", authenticateInvestor, async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT user_id, email, first_name, last_name, phone, role, status, created_at FROM users WHERE status = 'pending' ORDER BY created_at DESC"
    );
    
    res.status(200).json({ 
      success: true, 
      users: rows,
      count: rows.length 
    });
  } catch (error) {
    console.error("Error fetching pending users:", error);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

// ✅ SIGNUP
router.post("/signup", async (req, res) => {
  try {
    const { email, password, first_name, last_name, phone, role } = req.body;

    // 🔍 1. Validate required fields
    if (!email || !password || !first_name || !last_name || !role) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }

    // 🎯 2. Validate role
    const validRoles = ['tenant', 'supplier', 'investor'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ success: false, message: "Invalid role" });
    }

     const emailToCheck = email.toLowerCase();
    const [existing] = await db.execute("SELECT * FROM users WHERE LOWER(email) = ?", [emailToCheck]);
    if (existing.length > 0) {
      return res.status(409).json({ success: false, message: "Email already exists" });
    }

    // 🗃️ 4. Insert new user into database (password as plain-text for now)
    await db.execute(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, phone, status, is_active)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 1)`,
      [email, password, role, first_name, last_name, phone || null]
    );

    // 📬 5. Try sending email, but don't block signup if it fails
    try {
      await sendEmail(
        email,
        "Signup Request Received",
        `Hi ${first_name},\n\nThank you for signing up as a ${role}.\nYour account is pending approval. You'll be notified once approved.\n\n- Rental App Team`
      );
    } catch (emailErr) {
      console.error("Email sending failed:", emailErr.message);
      // Don't return error to client if email fails — only log
    }

    // ✅ 6. Respond success
    res.status(201).json({ success: true, message: "Signup submitted. Awaiting approval." });
  } catch (error) {
    console.error("Signup error:", error);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

// ✅ LOGIN
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  const [rows] = await db.execute("SELECT * FROM users WHERE email = ?", [email]);
  const user = rows[0];

  if (!user || !user.is_active || user.status !== "approved") {
    return res.status(403).json({ success: false, message: "User not approved or inactive" });
  }

  if (password !== user.password_hash) {
    return res.status(400).json({ success: false, message: "Invalid credentials" });
  }

  const token = jwt.sign(
    { userId: user.user_id, role: user.role },
    process.env.JWT_SECRET ,
    { expiresIn: "1h" }
  );


  res.status(200).json({ success: true, token });
});

// ✅ APPROVE or REJECT
router.post("/approve/:userId", authenticateInvestor, async (req, res) => {
  const { userId } = req.params;
  const { status, reason } = req.body;

  if (!["approved", "rejected"].includes(status)) {
    return res.status(400).json({ success: false, message: "Invalid status. Use 'approved' or 'rejected'." });
  }

  // If approved, set is_active=1; if rejected, set is_active=0
  await db.execute(
    "UPDATE users SET status = ?, rejected_reason = ?, is_active = ? WHERE user_id = ?",
    [
      status,
      status === "rejected" ? reason || null : null,
      status === "approved" ? 1 : 0,
      userId
    ]
  );

  const [rows] = await db.execute("SELECT email, role, first_name FROM users WHERE user_id = ?", [userId]);
  const user = rows[0];

  if (user?.email) {
    if (status === "approved") {
      const loginLinks = {
        tenant: "https://yourapp.com/tenant/login",
        supplier: "https://yourapp.com/supplier/login",
        investor: "https://yourapp.com/investor/login"
      };
      const link = loginLinks[user.role] || "https://yourapp.com/login";

      await sendEmail(
        user.email,
        "Account Approved",
        `🎉 Hi ${user.first_name}, your account has been approved!\nLogin here: ${link}`
      );
    } else {
      await sendEmail(
        user.email,
        "Account Rejected",
        `❌ Sorry, your account has been rejected.${reason ? "\nReason: " + reason : ""}`
      );
    }
  }

  res.status(200).json({ success: true, message: `User has been ${status}.` });
});

export { router as auth };
