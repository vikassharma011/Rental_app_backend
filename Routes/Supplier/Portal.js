

import express from "express";
import { db } from "../../db.js";
import jwt from "jsonwebtoken";
const router = express.Router();

// Simple authentication middleware for supplier
function authenticateSupplier(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  console.log('🔐 Supplier Auth - Token present:', !!token);
  console.log('🔐 Supplier Auth - Headers:', req.headers);
  
  if (!token) {
    console.log('❌ Supplier Auth - No token provided');
    return res.status(401).json({ success: false, message: "No token provided" });
  }
  
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    console.log('🔐 Supplier Auth - Decoded token:', decoded);
    console.log('🔐 Supplier Auth - User role:', decoded.role);
    console.log('🔐 Supplier Auth - Expected role: supplier');
    
    if (decoded.role !== "supplier") {
      console.log('❌ Supplier Auth - Role mismatch:', decoded.role);
      return res.status(403).json({ success: false, message: "Only suppliers allowed" });
    }
    
    req.user = decoded;
    console.log('✅ Supplier Auth - Authentication successful');
    next();
  } catch (error) {
    console.log('❌ Supplier Auth - JWT verification failed:', error.message);
    res.status(401).json({ success: false, message: "Invalid token" });
  }
}

// Get auto-pay settings for tenants linked to supplier's properties
router.get("/auto-pay/:supplier_id", authenticateSupplier, async (req, res) => {
  try {
    const supplier_id = req.params.supplier_id;
    // Find all tenants for properties where this supplier has maintenance requests
    const [rows] = await db.execute(`
      SELECT 
        aps.setting_id,
        aps.tenant_id,
        aps.lease_id,
        aps.payment_method_id,
        aps.is_active,
        aps.auto_pay_date,
        aps.created_at,
        aps.updated_at,
        tpm.payment_type,
        tpm.card_last4,
        tpm.bank_name,
        tpm.upi_id,
        u.first_name AS tenant_first_name,
        u.last_name AS tenant_last_name,
        p.title AS property_title,
        l.start_date AS lease_start,
        l.end_date AS lease_end
      FROM auto_pay_settings aps
      JOIN tenant_payment_methods tpm ON aps.payment_method_id = tpm.method_id
      JOIN users u ON aps.tenant_id = u.user_id
      JOIN leases l ON aps.lease_id = l.lease_id
      JOIN property p ON l.property_id = p.property_id
      JOIN maintenance_requests mr ON mr.property_id = p.property_id AND mr.supplier_id = ?
      WHERE aps.is_active = 1
      GROUP BY aps.setting_id
      ORDER BY aps.updated_at DESC
    `, [supplier_id]);
    res.json({ auto_pay_settings: rows });
  } catch (error) {
    console.error("Error fetching auto-pay settings for supplier:", error);
    res.status(500).json({ error: error.message });
  }
});


// Get contacts for supplier messaging (investors and tenants linked to supplier)
router.get('/contacts/:userId', authenticateSupplier, async (req, res) => {
  try {
    const userId = req.params.userId;
    const search = req.query.search ? `%${req.query.search}%` : null;

    // Get investors for properties supplier worked on
    let investorSQL = `
      SELECT DISTINCT i.user_id AS id, CONCAT(i.first_name, ' ', i.last_name) AS name, 'investor' AS role
      FROM users i
      JOIN property p ON i.user_id = p.investor_id
      JOIN maintenance_requests m ON p.property_id = m.property_id
      WHERE m.supplier_id = ? AND i.is_active = 1
    `;
    let investorParams = [userId];
    if (search) {
      investorSQL += ' AND (i.first_name LIKE ? OR i.last_name LIKE ? OR i.email LIKE ?)';
      investorParams.push(search, search, search);
    }
    const [investors] = await db.execute(investorSQL, investorParams);

    // Get tenants for properties supplier worked on
    let tenantSQL = `
      SELECT DISTINCT t.user_id AS id, CONCAT(t.first_name, ' ', t.last_name) AS name, 'tenant' AS role
      FROM users t
      JOIN leases l ON t.user_id = l.tenant_id
      JOIN maintenance_requests m ON l.property_id = m.property_id
      WHERE m.supplier_id = ? AND t.is_active = 1
    `;
    let tenantParams = [userId];
    if (search) {
      tenantSQL += ' AND (t.first_name LIKE ? OR t.last_name LIKE ? OR t.email LIKE ?)';
      tenantParams.push(search, search, search);
    }
    const [tenants] = await db.execute(tenantSQL, tenantParams);

    res.json({ contacts: [...investors, ...tenants] });
  } catch (error) {
    console.error('Error fetching contacts:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get available maintenance requests for suppliers
router.get('/maintenance-requests', authenticateSupplier, async (req, res) => {
  try {
    const [requests] = await db.execute(`
      SELECT 
        mr.*,
        u.first_name as tenant_first_name,
        u.last_name as tenant_last_name,
        p.title as property_title,
        p.address as property_address
      FROM maintenance_requests mr
      LEFT JOIN users u ON mr.tenant_id = u.user_id
      LEFT JOIN property p ON mr.property_id = p.property_id
      WHERE mr.status = 'pending' AND mr.supplier_id IS NULL
      ORDER BY mr.created_at DESC
    `);
    
    res.json({ requests });
  } catch (error) {
    console.error('Error fetching maintenance requests:', error);
    res.status(500).json({ error: error.message });
  }
});

// Submit quote for maintenance request
router.post('/submit-quote', authenticateSupplier, async (req, res) => {
  try {
    const { request_id, amount, description } = req.body;
    const supplier_id = req.user.userId;
    if (!request_id || !amount) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Check if supplier already submitted a quote for this request
    const [existingQuote] = await db.execute(
      'SELECT * FROM maintenance_quotes WHERE request_id = ? AND supplier_id = ?',
      [request_id, supplier_id]
    );

    if (existingQuote.length > 0) {
      return res.status(400).json({ error: 'You have already submitted a quote for this request' });
    }

    await db.execute(
      'INSERT INTO maintenance_quotes (request_id, supplier_id, amount, description, status) VALUES (?, ?, ?, ?, ?)',
      [request_id, supplier_id, amount, description, 'pending']
    );

    res.json({ success: true, message: 'Quote submitted successfully' });
  } catch (error) {
    console.error('Error submitting quote:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update task status
router.put('/tasks/:taskId/status', authenticateSupplier, async (req, res) => {
  try {
    const { taskId } = req.params;
    const { status, progress_update, time_spent } = req.body;
    
    await db.execute(
      'UPDATE maintenance_requests SET status = ?, updated_at = NOW() WHERE request_id = ?',
      [status, taskId]
    );

    // Add progress update to maintenance_updates table if it exists
    if (progress_update) {
      // Ensure maintenance_updates table exists (guard for missing table)
      await db.execute(`
        CREATE TABLE IF NOT EXISTS maintenance_updates (
          update_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          request_id BIGINT UNSIGNED NOT NULL,
          supplier_id BIGINT UNSIGNED NOT NULL,
          update_text TEXT,
          time_spent INT NULL,
          created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (update_id),
          INDEX idx_request_id (request_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      `);
      await db.execute(
        'INSERT INTO maintenance_updates (request_id, supplier_id, update_text, time_spent, created_at) VALUES (?, ?, ?, ?, NOW())',
        [taskId, req.user.userId, progress_update, time_spent || null]
      );
    }

    res.json({ success: true, message: 'Task status updated successfully' });
  } catch (error) {
    console.error('Error updating task status:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create inventory request
router.post('/inventory-request', authenticateSupplier, async (req, res) => {
  try {
    const { item_name, property_id, item_type, purchase_date, warranty_end_date } = req.body;
    const supplier_id = req.user.userId;
    
    if (!item_name || !property_id) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    await db.execute(
      'INSERT INTO inventory_requests (item_name, supplier_id, property_id, item_type, purchase_date, warranty_end_date, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [item_name, supplier_id, property_id, item_type, purchase_date, warranty_end_date, 'pending']
    );

    res.json({ success: true, message: 'Inventory request submitted successfully' });
  } catch (error) {
    console.error('Error creating inventory request:', error);
    res.status(500).json({ error: error.message });
  }
});

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

// Get tasks for supplier
router.get("/tasks/:id", authenticateSupplier, async (req, res) => {
  try {
    const supplier_id = req.params.id;
    const [tasks] = await db.execute(`
      SELECT 
        mr.*,
        p.title as property_title,
        u.first_name as tenant_first_name,
        u.last_name as tenant_last_name,
        mq.amount as quote_amount,
        mq.status as quote_status,
        mq.payment_status
      FROM maintenance_requests mr
      LEFT JOIN property p ON mr.property_id = p.property_id
      LEFT JOIN users u ON mr.tenant_id = u.user_id
      LEFT JOIN maintenance_quotes mq ON mr.request_id = mq.request_id AND mq.supplier_id = ?
      WHERE mr.supplier_id = ?
      ORDER BY mr.created_at DESC
    `, [supplier_id, supplier_id]);
    
    res.json({ tasks });
  } catch (error) {
    console.error("Error fetching supplier tasks:", error);
    res.status(500).json({ error: error.message });
  }
});

// Get/update supplier profile
router.get("/profile/:id", async (req, res) => {
  try {
    const supplier_id = req.params.id;
    const [[profile]] = await db.execute("SELECT * FROM users WHERE user_id = ? AND role = 'supplier'", [supplier_id]);
    
    // Get bank accounts
    const [bankAccounts] = await db.execute(
      "SELECT * FROM supplier_bank_accounts WHERE supplier_id = ? AND is_active = 1 ORDER BY is_default DESC, created_at DESC",
      [supplier_id]
    );
    
    // Get additional stats
    const [tasks] = await db.execute("SELECT COUNT(*) as total_tasks FROM maintenance_requests WHERE supplier_id = ?", [supplier_id]);
    const [completedTasks] = await db.execute("SELECT COUNT(*) as completed_tasks FROM maintenance_requests WHERE supplier_id = ? AND status = 'completed'", [supplier_id]);
    const [earnings] = await db.execute("SELECT SUM(amount) as total_earnings FROM payments WHERE supplier_id = ? AND status = 'completed'", [supplier_id]);
    
    res.json({ 
      profile: {
        ...profile,
        total_tasks: tasks[0]?.total_tasks || 0,
        completed_tasks: completedTasks[0]?.completed_tasks || 0,
        total_earnings: earnings[0]?.total_earnings || 0
      },
      bank_accounts: bankAccounts
    });
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

// Change supplier password
router.put("/profile/:id/change-password", async (req, res) => {
  try {
    const { id } = req.params;
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
      return res.status(400).json({ error: "Current and new password are required" });
    }
    const [[user]] = await db.execute(
      "SELECT password_hash FROM users WHERE user_id = ? AND role = 'supplier'",
      [id]
    );
    if (!user) return res.status(404).json({ error: "User not found" });
    if (user.password_hash !== current_password) {
      return res.status(400).json({ error: "Current password is incorrect" });
    }
    await db.execute(
      "UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND role = 'supplier'",
      [new_password, id]
    );
    res.json({ message: "Password changed successfully" });
  } catch (error) {
    console.error("Error changing supplier password:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Upload supplier profile picture (accepts Cloudinary URL via file_url)
router.post("/profile/:id/upload-picture", async (req, res) => {
  try {
    const { id } = req.params;
    const { file_url } = req.body || {};
    if (!file_url) return res.status(400).json({ error: "file_url is required" });
    await db.execute(
      "UPDATE users SET profile_picture_url = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND role = 'supplier'",
      [file_url, id]
    );
    res.json({ message: "Profile picture updated", profile_picture_url: file_url });
  } catch (error) {
    console.error("Error uploading supplier profile picture:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// (removed duplicate unprotected /tasks/:id route)

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

// (removed duplicate simple earnings route; richer route below is used)

// Get supplier inventory requests
router.get('/inventory-requests/:id', authenticateSupplier, async (req, res) => {
  try {
    const supplier_id = req.params.id;
    const [requests] = await db.execute(
      `SELECT ir.*,
              p.title as property_title
       FROM inventory_requests ir
       LEFT JOIN property p ON ir.property_id = p.property_id
       WHERE ir.supplier_id = ?
       ORDER BY ir.created_at DESC`,
      [supplier_id]
    );
    res.json({ requests });
  } catch (error) {
    console.error('Error fetching inventory requests:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update inventory request status
router.put('/inventory-requests/:requestId/status', authenticateSupplier, async (req, res) => {
  try {
    const { requestId } = req.params;
    const { status } = req.body;
    const allowed = ['pending', 'approved', 'in_transit', 'provided', 'delayed', 'rejected'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    await db.execute(
      `UPDATE inventory_requests SET status = ?, updated_at = NOW() WHERE request_id = ?`,
      [status, requestId]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating inventory request status:', error);
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

// Helper to ensure supplier_settings table exists
async function ensureSupplierSettingsTable() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS supplier_settings (
      supplier_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
      email_notifications TINYINT(1) DEFAULT 1,
      sms_notifications TINYINT(1) DEFAULT 0,
      push_notifications TINYINT(1) DEFAULT 1,
      auto_accept_tasks TINYINT(1) DEFAULT 0,
      availability VARCHAR(20) DEFAULT 'Online',
      business_start_time VARCHAR(5) DEFAULT '09:00',
      business_end_time VARCHAR(5) DEFAULT '18:00',
      max_tasks_per_day INT DEFAULT 5,
      preferred_language VARCHAR(32) DEFAULT 'English',
      theme VARCHAR(16) DEFAULT 'Light',
      created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8;
  `);
}

// Get supplier settings
router.get("/settings/:id", authenticateSupplier, async (req, res) => {
  try {
    const supplier_id = req.params.id;
    await ensureSupplierSettingsTable();
    const [rows] = await db.execute(
      `SELECT * FROM supplier_settings WHERE supplier_id = ?`,
      [supplier_id]
    );
    let settings;
    if (!rows || rows.length === 0) {
      // Initialize with defaults
      await db.execute(
        `INSERT INTO supplier_settings (supplier_id) VALUES (?)`,
        [supplier_id]
      );
      settings = {
        emailNotifications: 1,
        smsNotifications: 0,
        pushNotifications: 1,
        autoAcceptTasks: 0,
        availability: 'Online',
        businessHours: { start: '09:00', end: '18:00' },
        maxTasksPerDay: 5,
        preferredLanguage: 'English',
        theme: 'Light'
      };
    } else {
      const row = rows[0];
      settings = {
        emailNotifications: !!row.email_notifications,
        smsNotifications: !!row.sms_notifications,
        pushNotifications: !!row.push_notifications,
        autoAcceptTasks: !!row.auto_accept_tasks,
        availability: row.availability || 'Online',
        businessHours: {
          start: row.business_start_time || '09:00',
          end: row.business_end_time || '18:00'
        },
        maxTasksPerDay: row.max_tasks_per_day ?? 5,
        preferredLanguage: row.preferred_language || 'English',
        theme: row.theme || 'Light'
      };
    }
    res.json({ settings });
  } catch (error) {
    console.error('Error fetching supplier settings:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update supplier settings (and availability)
router.put("/settings/:id", authenticateSupplier, async (req, res) => {
  try {
    const supplier_id = req.params.id;
    await ensureSupplierSettingsTable();

    const {
      emailNotifications,
      smsNotifications,
      pushNotifications,
      autoAcceptTasks,
      availability,
      businessHours,
      maxTasksPerDay,
      preferredLanguage,
      theme,
      is_active
    } = req.body || {};

    // Upsert settings row
    const [existing] = await db.execute(
      `SELECT supplier_id FROM supplier_settings WHERE supplier_id = ?`,
      [supplier_id]
    );
    const hasRow = existing && existing.length > 0;

    // Build update parts dynamically
    const updates = [];
    const params = [];

    if (emailNotifications !== undefined) { updates.push('email_notifications = ?'); params.push(emailNotifications ? 1 : 0); }
    if (smsNotifications !== undefined) { updates.push('sms_notifications = ?'); params.push(smsNotifications ? 1 : 0); }
    if (pushNotifications !== undefined) { updates.push('push_notifications = ?'); params.push(pushNotifications ? 1 : 0); }
    if (autoAcceptTasks !== undefined) { updates.push('auto_accept_tasks = ?'); params.push(autoAcceptTasks ? 1 : 0); }
    if (availability !== undefined) { updates.push('availability = ?'); params.push(availability); }
    if (businessHours && (businessHours.start || businessHours.end)) {
      if (businessHours.start !== undefined) { updates.push('business_start_time = ?'); params.push(businessHours.start); }
      if (businessHours.end !== undefined) { updates.push('business_end_time = ?'); params.push(businessHours.end); }
    }
    if (maxTasksPerDay !== undefined) { updates.push('max_tasks_per_day = ?'); params.push(parseInt(maxTasksPerDay)); }
    if (preferredLanguage !== undefined) { updates.push('preferred_language = ?'); params.push(preferredLanguage); }
    if (theme !== undefined) { updates.push('theme = ?'); params.push(theme); }

    if (!hasRow) {
      await db.execute(`INSERT INTO supplier_settings (supplier_id) VALUES (?)`, [supplier_id]);
    }
    if (updates.length > 0) {
      const sql = `UPDATE supplier_settings SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE supplier_id = ?`;
      params.push(supplier_id);
      await db.execute(sql, params);
    }

    // Optionally reflect availability to users.is_active
    if (is_active !== undefined) {
      await db.execute(`UPDATE users SET is_active = ? WHERE user_id = ? AND role = 'supplier'`, [is_active ? 1 : 0, supplier_id]);
    } else if (availability !== undefined) {
      const active = availability === 'Online' ? 1 : 0;
      await db.execute(`UPDATE users SET is_active = ? WHERE user_id = ? AND role = 'supplier'`, [active, supplier_id]);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating supplier settings:', error);
    res.status(500).json({ error: error.message });
  }
});

// Communication (messaging)
router.get("/communication/inbox/:id", authenticateSupplier, async (req, res) => {
  try {
    const supplier_id = req.params.id;
    const [messages] = await db.execute("SELECT * FROM messages WHERE receiver_id = ?", [supplier_id]);
    res.json({ messages });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/communication/sent/:id", authenticateSupplier, async (req, res) => {
  try {
    const supplier_id = req.params.id;
    const [messages] = await db.execute("SELECT * FROM messages WHERE sender_id = ?", [supplier_id]);
    res.json({ messages });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Send a message (supplier, tenant, investor)
router.post("/communication/send", authenticateSupplier, async (req, res) => {
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

// Get investor contact for supplier
router.get('/messaging/contacts/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    const search = req.query.search ? `%${req.query.search}%` : null;

    // Get investor linked to supplier's maintenance requests
    let investorSQL = `
      SELECT DISTINCT
        u.user_id AS id, 
        CONCAT(u.first_name, ' ', u.last_name) AS name, 
        'investor' AS role,
        u.email,
        u.profile_image,
        p.property_id,
        p.title AS property_name,
        (SELECT COUNT(*) FROM messages m WHERE 
          ((m.sender_id = u.user_id AND m.receiver_id = ?) OR 
           (m.sender_id = ? AND m.receiver_id = u.user_id)) AND 
          m.is_read = 0 AND m.sender_id != ?) AS unread_count,
        (SELECT m.content FROM messages m WHERE 
          ((m.sender_id = u.user_id AND m.receiver_id = ?) OR 
           (m.sender_id = ? AND m.receiver_id = u.user_id)) 
          ORDER BY m.created_at DESC LIMIT 1) AS last_message,
        (SELECT m.created_at FROM messages m WHERE 
          ((m.sender_id = u.user_id AND m.receiver_id = ?) OR 
           (m.sender_id = ? AND m.receiver_id = u.user_id)) 
          ORDER BY m.created_at DESC LIMIT 1) AS last_message_time
      FROM users u
      JOIN property p ON u.user_id = p.investor_id
      JOIN maintenance_requests m ON p.property_id = m.property_id
      WHERE m.supplier_id = ? AND u.is_active = 1
    `;
    let investorParams = [userId, userId, userId, userId, userId, userId, userId, userId];
    if (search) {
      investorSQL += ' AND (u.first_name LIKE ? OR u.last_name LIKE ? OR u.email LIKE ?)';
      investorParams.push(search, search, search);
    }
    const [investors] = await db.execute(investorSQL, investorParams);

    // Sort by last message time (most recent first)
    investors.sort((a, b) => {
      if (!a.last_message_time && !b.last_message_time) return 0;
      if (!a.last_message_time) return 1;
      if (!b.last_message_time) return -1;
      return new Date(b.last_message_time) - new Date(a.last_message_time);
    });

    res.json({ contacts: investors });
  } catch (error) {
    console.error('Error fetching investor contacts:', error);
    res.status(500).json({ error: error.message });
  }
});

// Send message (supplier to investor)
router.post("/messaging/send", async (req, res) => {
  try {
    const { sender_id, receiver_id, role, content, message_type = 'text' } = req.body;
    
    if (!sender_id || !receiver_id || !role || !content) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const [result] = await db.execute(
      `INSERT INTO messages (sender_id, receiver_id, role, content, message_type, created_at) 
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [sender_id, receiver_id, role, content, message_type]
    );

    // Get the created message with full details
    const [messageResult] = await db.execute(
      `SELECT m.*, 
              CONCAT(s.first_name, ' ', s.last_name) as sender_name,
              CONCAT(r.first_name, ' ', r.last_name) as receiver_name
       FROM messages m
       JOIN users s ON m.sender_id = s.user_id
       JOIN users r ON m.receiver_id = r.user_id
       WHERE m.message_id = ?`,
      [result.insertId]
    );

    res.status(201).json({ 
      message: "Message sent", 
      messageData: messageResult[0] 
    });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get messages between supplier and investor
router.get("/messaging/inbox/:id", async (req, res) => {
  try {
    const user_id = req.params.id;
    const contact_id = req.query.contact_id;

    if (!contact_id) {
      return res.status(400).json({ error: "Missing contact_id query parameter" });
    }

    const [messages] = await db.execute(
      `SELECT m.*, 
              CONCAT(s.first_name, ' ', s.last_name) as sender_name,
              CONCAT(r.first_name, ' ', r.last_name) as receiver_name
       FROM messages m
       JOIN users s ON m.sender_id = s.user_id
       JOIN users r ON m.receiver_id = r.user_id
       WHERE (m.sender_id = ? AND m.receiver_id = ?) 
          OR (m.sender_id = ? AND m.receiver_id = ?) 
       ORDER BY m.created_at ASC`,
      [user_id, contact_id, contact_id, user_id]
    );

    // Mark messages as read
    await db.execute(
      `UPDATE messages SET is_read = 1 
       WHERE sender_id = ? AND receiver_id = ? AND is_read = 0`,
      [contact_id, user_id]
    );

    res.json({ messages });
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ error: error.message });
  }
});

// Mark messages as read
router.put("/messaging/read/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const { contact_id } = req.body;

    if (!contact_id) {
      return res.status(400).json({ error: "Missing contact_id" });
    }

    await db.execute(
      `UPDATE messages SET is_read = 1 
       WHERE sender_id = ? AND receiver_id = ? AND is_read = 0`,
      [contact_id, userId]
    );

    res.json({ message: "Messages marked as read" });
  } catch (error) {
    console.error('Error marking messages as read:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get unread message count
router.get("/messaging/unread/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    
    const [result] = await db.execute(
      `SELECT COUNT(*) as unread_count FROM messages 
       WHERE receiver_id = ? AND is_read = 0`,
      [userId]
    );

    res.json({ unread_count: result[0].unread_count });
  } catch (error) {
    console.error('Error fetching unread count:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get supplier earnings data
router.get("/earnings/:id", authenticateSupplier, async (req, res) => {
  try {
    const supplier_id = req.params.id;
    
    // Get supplier payments (using supplier_payments which links to maintenance_requests)
    const [payments] = await db.execute(`
      SELECT 
        sp.payment_id,
        sp.amount,
        sp.payment_method,
        sp.status,
        sp.transaction_id,
        sp.payment_date,
        sp.remarks,
        sp.created_at,
        sp.updated_at,
        mr.issue_description,
        pr.title AS property_title
      FROM supplier_payments sp
      LEFT JOIN maintenance_requests mr ON sp.maintenance_request_id = mr.request_id
      LEFT JOIN property pr ON mr.property_id = pr.property_id
      WHERE sp.supplier_id = ?
      ORDER BY COALESCE(sp.payment_date, sp.created_at) DESC
    `, [supplier_id]);
    
    // Get pending payments
    const [pending] = await db.execute(`
      SELECT 
        mq.*,
        mr.issue_description,
        pr.title as property_title
      FROM maintenance_quotes mq
      LEFT JOIN maintenance_requests mr ON mq.request_id = mr.request_id
      LEFT JOIN property pr ON mr.property_id = pr.property_id
      WHERE mq.supplier_id = ? AND mq.status = 'accepted' AND mq.payment_status = 'pending'
      ORDER BY mq.created_at DESC
    `, [supplier_id]);
    
    // Calculate totals
    const totalEarnings = payments
      .filter(p => p.status === 'completed')
      .reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
    const pendingAmount = pending.reduce((sum, p) => sum + parseFloat(p.amount), 0);
    
    res.json({ 
      payments,
      pending,
      totalEarnings,
      pendingAmount
    });
  } catch (error) {
    console.error('Error fetching supplier earnings:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update supplier quote status
router.put("/quote/:id/status", authenticateSupplier, async (req, res) => {
  try {
    const { status } = req.body;
    
    await db.execute(`
      UPDATE maintenance_quotes 
      SET status = ?, updated_at = NOW()
      WHERE quote_id = ? AND supplier_id = ?
    `, [status, req.params.id, req.user.userId]);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating quote status:', error);
    res.status(500).json({ error: error.message });
  }
});

// Submit quote for maintenance request
router.post("/quote", authenticateSupplier, async (req, res) => {
  try {
    const { request_id, amount, description } = req.body;
    
    if (!request_id || !amount) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    
    const [result] = await db.execute(`
      INSERT INTO maintenance_quotes (request_id, supplier_id, amount, description, status, created_at)
      VALUES (?, ?, ?, ?, 'pending', NOW())
    `, [request_id, req.user.userId, amount, description || '']);
    
    res.status(201).json({ 
      message: "Quote submitted successfully",
      quote_id: result.insertId
    });
  } catch (error) {
    console.error('Error submitting quote:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get supplier bank accounts
router.get("/bank-accounts/:supplierId", authenticateSupplier, async (req, res) => {
  try {
    const { supplierId } = req.params;
    
    const [accounts] = await db.execute(
      "SELECT * FROM supplier_bank_accounts WHERE supplier_id = ? AND is_active = 1 ORDER BY is_default DESC, created_at DESC",
      [supplierId]
    );
    
    res.json({ bank_accounts: accounts });
  } catch (error) {
    console.error("Error fetching bank accounts:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Add new bank account
router.post("/bank-accounts/:supplierId", authenticateSupplier, async (req, res) => {
  try {
    const { supplierId } = req.params;
    const { bank_name, account_number, ifsc_code, account_holder_name, is_default } = req.body;
    
    // Validate required fields
    if (!bank_name || !account_number || !ifsc_code || !account_holder_name) {
      return res.status(400).json({ error: "All fields are required" });
    }
    
    // If this is set as default, unset other defaults
    if (is_default) {
      await db.execute(
        "UPDATE supplier_bank_accounts SET is_default = 0 WHERE supplier_id = ?",
        [supplierId]
      );
    }
    
    // Insert new bank account
    const [result] = await db.execute(
      "INSERT INTO supplier_bank_accounts (supplier_id, bank_name, account_number, ifsc_code, account_holder_name, is_default) VALUES (?, ?, ?, ?, ?, ?)",
      [supplierId, bank_name, account_number, ifsc_code, account_holder_name, is_default ? 1 : 0]
    );
    
    res.json({ 
      message: "Bank account added successfully",
      account_id: result.insertId
    });
  } catch (error) {
    console.error("Error adding bank account:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Update bank account
router.put("/bank-accounts/:supplierId/:accountId", authenticateSupplier, async (req, res) => {
  try {
    const { supplierId, accountId } = req.params;
    const { bank_name, account_number, ifsc_code, account_holder_name, is_default } = req.body;
    
    // If this is set as default, unset other defaults
    if (is_default) {
      await db.execute(
        "UPDATE supplier_bank_accounts SET is_default = 0 WHERE supplier_id = ? AND account_id != ?",
        [supplierId, accountId]
      );
    }
    
    // Update bank account
    await db.execute(
      "UPDATE supplier_bank_accounts SET bank_name = ?, account_number = ?, ifsc_code = ?, account_holder_name = ?, is_default = ? WHERE account_id = ? AND supplier_id = ?",
      [bank_name, account_number, ifsc_code, account_holder_name, is_default ? 1 : 0, accountId, supplierId]
    );
    
    res.json({ message: "Bank account updated successfully" });
  } catch (error) {
    console.error("Error updating bank account:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Delete bank account
router.delete("/bank-accounts/:supplierId/:accountId", authenticateSupplier, async (req, res) => {
  try {
    const { supplierId, accountId } = req.params;
    
    await db.execute(
      "UPDATE supplier_bank_accounts SET is_active = 0 WHERE account_id = ? AND supplier_id = ?",
      [accountId, supplierId]
    );
    
    res.json({ message: "Bank account deleted successfully" });
  } catch (error) {
    console.error("Error deleting bank account:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export { router as SupplierPortalRouter };
