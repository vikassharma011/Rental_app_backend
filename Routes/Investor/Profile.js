import express from "express";
import { db } from "../../db.js";
import multer from "multer";
import path from "path";

const router = express.Router();

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/profile-pictures/');
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'profile-' + req.params.id + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  },
  fileFilter: function (req, file, cb) {
    // Accept only image files
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'), false);
    }
  }
});

// Get investor profile with comprehensive data
router.get("/profile/:id", async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get basic user info
    const [[user]] = await db.execute(
      "SELECT user_id, first_name, last_name, email, phone, role, status, profile_picture_url, created_at FROM users WHERE user_id = ? AND role = 'investor'",
      [id]
    );

    if (!user) {
      return res.status(404).json({ error: "Investor not found" });
    }

    // Get properties count and details
    const [properties] = await db.execute(
      "SELECT property_id, title, city, state, image_url FROM property WHERE investor_id = ?",
      [id]
    );

    // Get active leases count
    const [leases] = await db.execute(
      `SELECT l.lease_id, l.rent_amount, l.end_date, l.status,
              p.title as property_title, p.city,
              CONCAT(u.first_name, ' ', u.last_name) as tenant_name
       FROM leases l
       JOIN property p ON l.property_id = p.property_id
       JOIN users u ON l.tenant_id = u.user_id
       WHERE p.investor_id = ? AND l.end_date >= CURDATE()`,
      [id]
    );

    // Get payments summary
    const [payments] = await db.execute(
      `SELECT 
        COUNT(CASE WHEN status = 'completed' AND payment_type = 'rent' THEN 1 END) as completed_rent_payments,
        COUNT(CASE WHEN status = 'pending' AND payment_type = 'rent' THEN 1 END) as pending_rent_payments,
        COUNT(CASE WHEN status = 'completed' AND payment_type = 'supplier' THEN 1 END) as completed_supplier_payments,
        COUNT(CASE WHEN status = 'pending' AND payment_type = 'supplier' THEN 1 END) as pending_supplier_payments,
        SUM(CASE WHEN status = 'completed' AND payment_type = 'rent' THEN amount ELSE 0 END) as total_rent_collected,
        SUM(CASE WHEN status = 'pending' AND payment_type = 'rent' THEN amount ELSE 0 END) as pending_rent_amount
       FROM payments p
       JOIN leases l ON p.lease_id = l.lease_id
       JOIN property prop ON l.property_id = prop.property_id
       WHERE prop.investor_id = ?`,
      [id]
    );

    // Get maintenance requests summary
    const [maintenanceRequests] = await db.execute(
      `SELECT 
        mr.request_id, mr.issue_description, mr.status, mr.priority, mr.created_at,
        p.title as property_title,
        CONCAT(u.first_name, ' ', u.last_name) as tenant_name
       FROM maintenance_requests mr
       JOIN property p ON mr.property_id = p.property_id
       JOIN users u ON mr.tenant_id = u.user_id
       WHERE p.investor_id = ? AND mr.status != 'completed'
       ORDER BY mr.created_at DESC
       LIMIT 10`,
      [id]
    );

    // Get recent messages
    const [messages] = await db.execute(
      `SELECT 
        m.message_id, m.content, m.created_at, m.is_read,
        CONCAT(u.first_name, ' ', u.last_name) as sender_name,
        u.role as sender_role
       FROM messages m
       JOIN users u ON m.sender_id = u.user_id
       WHERE m.receiver_id = ? OR m.sender_id = ?
       ORDER BY m.created_at DESC
       LIMIT 10`,
      [id, id]
    );

    // Get rent schedules for upcoming payments
    const [rentSchedules] = await db.execute(
      `SELECT 
        rs.schedule_id, rs.month_year, rs.due_date, rs.amount, rs.status,
        p.title as property_title,
        CONCAT(u.first_name, ' ', u.last_name) as tenant_name
       FROM rent_schedules rs
       JOIN leases l ON rs.lease_id = l.lease_id
       JOIN property p ON l.property_id = p.property_id
       JOIN users u ON l.tenant_id = u.user_id
       WHERE p.investor_id = ? AND rs.status = 'pending' AND rs.due_date >= CURDATE()
       ORDER BY rs.due_date ASC
       LIMIT 10`,
      [id]
    );

    // Calculate statistics
    const stats = {
      totalProperties: properties.length,
      activeLeases: leases.length,
      completedPayments: payments[0]?.completed_rent_payments || 0,
      pendingPayments: payments[0]?.pending_rent_payments || 0,
      totalRentCollected: payments[0]?.total_rent_collected || 0,
      pendingRentAmount: payments[0]?.pending_rent_amount || 0,
      pendingMaintenance: maintenanceRequests.length,
      leasesExpiringSoon: leases.filter(lease => {
        const endDate = new Date(lease.end_date);
        const today = new Date();
        const diffTime = endDate.getTime() - today.getTime();
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        return diffDays <= 90 && diffDays > 0;
      }).length
    };

    const profileData = {
      user: {
        ...user,
        name: `${user.first_name} ${user.last_name}`,
        joined_date: user.created_at,
        profilePic: user.profile_picture_url || `https://api.dicebear.com/7.x/thumbs/svg?seed=${user.user_id}`
      },
      properties,
      leases,
      payments: payments[0] || {},
      maintenanceRequests,
      messages,
      rentSchedules,
      stats
    };

    res.json(profileData);
  } catch (error) {
    console.error("Error fetching investor profile:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Update investor profile
router.put("/profile/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { first_name, last_name, email, phone } = req.body;

    // Validate required fields
    if (!first_name || !last_name || !email) {
      return res.status(400).json({ error: "First name, last name, and email are required" });
    }

    // Check if email already exists for another user
    const [existingUser] = await db.execute(
      "SELECT user_id FROM users WHERE email = ? AND user_id != ?",
      [email, id]
    );

    if (existingUser.length > 0) {
      return res.status(400).json({ error: "Email already exists" });
    }

    // Update user profile
    await db.execute(
      "UPDATE users SET first_name = ?, last_name = ?, email = ?, phone = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND role = 'investor'",
      [first_name, last_name, email, phone, id]
    );

    res.json({ message: "Profile updated successfully" });
  } catch (error) {
    console.error("Error updating investor profile:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Change password
router.put("/profile/:id/password", async (req, res) => {
  try {
    const { id } = req.params;
    const { oldPassword, newPassword } = req.body;

    if (!oldPassword || !newPassword) {
      return res.status(400).json({ error: "Old and new passwords are required" });
    }

    // Get current password hash
    const [[user]] = await db.execute(
      "SELECT password_hash FROM users WHERE user_id = ? AND role = 'investor'",
      [id]
    );

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // In a real app, you would hash and verify passwords properly
    // For now, we'll do a simple check (you should implement proper password hashing)
    if (user.password_hash !== oldPassword) {
      return res.status(400).json({ error: "Current password is incorrect" });
    }

    // Update password
    await db.execute(
      "UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND role = 'investor'",
      [newPassword, id]
    );

    res.json({ message: "Password changed successfully" });
  } catch (error) {
    console.error("Error changing password:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get investor dashboard summary
router.get("/dashboard/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // Get quick stats
    const [propertyCount] = await db.execute(
      "SELECT COUNT(*) as count FROM property WHERE investor_id = ?",
      [id]
    );

    const [activeLeaseCount] = await db.execute(
      `SELECT COUNT(*) as count FROM leases l
       JOIN property p ON l.property_id = p.property_id
       WHERE p.investor_id = ? AND l.end_date >= CURDATE()`,
      [id]
    );

    const [monthlyRent] = await db.execute(
      `SELECT SUM(l.rent_amount) as total FROM leases l
       JOIN property p ON l.property_id = p.property_id
       WHERE p.investor_id = ? AND l.end_date >= CURDATE()`,
      [id]
    );

    const [pendingMaintenance] = await db.execute(
      `SELECT COUNT(*) as count FROM maintenance_requests mr
       JOIN property p ON mr.property_id = p.property_id
       WHERE p.investor_id = ? AND mr.status != 'completed'`,
      [id]
    );

    const dashboardData = {
      totalProperties: propertyCount[0]?.count || 0,
      activeLeases: activeLeaseCount[0]?.count || 0,
      monthlyRent: monthlyRent[0]?.total || 0,
      pendingMaintenance: pendingMaintenance[0]?.count || 0
    };

    res.json(dashboardData);
  } catch (error) {
    console.error("Error fetching dashboard data:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get investor activity log
router.get("/activity/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { limit = 20, offset = 0 } = req.query;

    // Get recent activities from multiple sources
    const [activities] = await db.execute(
      `(SELECT 
          'payment' as type,
          p.payment_id as id,
          p.amount,
          p.payment_type,
          p.status,
          p.created_at,
          CONCAT('Payment of ₹', p.amount, ' received') as description
        FROM payments p
        JOIN leases l ON p.lease_id = l.lease_id
        JOIN property prop ON l.property_id = prop.property_id
        WHERE prop.investor_id = ?)
       UNION ALL
       (SELECT 
          'maintenance' as type,
          mr.request_id as id,
          NULL as amount,
          'maintenance' as payment_type,
          mr.status,
          mr.created_at,
          CONCAT('Maintenance request: ', mr.issue_description) as description
        FROM maintenance_requests mr
        JOIN property p ON mr.property_id = p.property_id
        WHERE p.investor_id = ?)
       UNION ALL
       (SELECT 
          'lease' as type,
          l.lease_id as id,
          l.rent_amount as amount,
          'lease' as payment_type,
          'active' as status,
          l.created_at,
          CONCAT('New lease created for ₹', l.rent_amount) as description
        FROM leases l
        JOIN property p ON l.property_id = p.property_id
        WHERE p.investor_id = ?)
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [id, id, id, parseInt(limit), parseInt(offset)]
    );

    res.json({ activities });
  } catch (error) {
    console.error("Error fetching activity log:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Upload profile picture
router.post("/profile/:id/upload-picture", upload.single('profile_picture'), async (req, res) => {
  try {
    const { id } = req.params;
    const { file_url } = req.body || {};
    
    // Support either direct Cloudinary URL via body or uploaded file
    if (!req.file && !file_url) {
      return res.status(400).json({ error: "No file uploaded or file_url provided" });
    }

    // Prefer provided Cloudinary URL; otherwise construct local URL
    const fileUrl = file_url || `${req.protocol}://${req.get('host')}/uploads/profile-pictures/${req.file.filename}`;
    
    // Update user profile with the new picture URL
    await db.execute(
      "UPDATE users SET profile_picture_url = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND role = 'investor'",
      [fileUrl, id]
    );

    res.json({ 
      message: "Profile picture uploaded successfully",
      profile_picture_url: fileUrl
    });
  } catch (error) {
    console.error("Error uploading profile picture:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export { router as ProfileRouter };
