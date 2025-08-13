
import express from "express";
import { db } from "../../db.js";
import jwt from "jsonwebtoken";
const router = express.Router();

// Simple authentication middleware for tenant
function authenticateTenant(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ success: false });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== "tenant") {
      return res.status(403).json({ success: false, message: "Only tenants allowed" });
    }
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ success: false, message: "Invalid token" });
  }
}



// Get contacts for tenant messaging (investor and suppliers linked to tenant)
router.get('/contacts/:userId', authenticateTenant, async (req, res) => {
  try {
    const userId = req.params.userId;
    const search = req.query.search ? `%${req.query.search}%` : null;

    // Get investor for tenant's property
    let investorSQL = `
      SELECT i.user_id AS id, CONCAT(i.first_name, ' ', i.last_name) AS name, 'investor' AS role
      FROM users i
      JOIN property p ON i.user_id = p.investor_id
      JOIN leases l ON p.property_id = l.property_id
      WHERE l.tenant_id = ? AND i.is_active = 1
    `;
    let investorParams = [userId];
    if (search) {
      investorSQL += ' AND (i.first_name LIKE ? OR i.last_name LIKE ? OR i.email LIKE ?)';
      investorParams.push(search, search, search);
    }
    const [investors] = await db.execute(investorSQL, investorParams);

    // Get suppliers who have worked on tenant's property
    let supplierSQL = `
      SELECT DISTINCT s.user_id AS id, CONCAT(s.first_name, ' ', s.last_name) AS name, 'supplier' AS role
      FROM users s
      JOIN maintenance_requests m ON s.user_id = m.supplier_id
      JOIN leases l ON m.property_id = l.property_id
      WHERE l.tenant_id = ? AND s.is_active = 1
    `;
    let supplierParams = [userId];
    if (search) {
      supplierSQL += ' AND (s.first_name LIKE ? OR s.last_name LIKE ? OR s.email LIKE ?)';
      supplierParams.push(search, search, search);
    }
    const [suppliers] = await db.execute(supplierSQL, supplierParams);

    const contacts = [...investors, ...suppliers];
    res.json({ contacts });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Dashboard summary for tenant
router.get("/dashboard/:id", async (req, res) => {
  try {
    const tenant_id = req.params.id;
    
    // Get lease with property details
    const [[lease]] = await db.execute(`
      SELECT l.*, p.title as property_title, p.address as property_address, p.city, p.state
      FROM leases l
      JOIN property p ON l.property_id = p.property_id
      WHERE l.tenant_id = ? 
      ORDER BY l.start_date DESC 
      LIMIT 1
    `, [tenant_id]);
    
    // Get recent payments
    const [payments] = await db.execute(`
      SELECT * FROM payments 
      WHERE tenant_id = ? 
      ORDER BY payment_date DESC 
      LIMIT 5
    `, [tenant_id]);
    
    // Get maintenance requests with status
    const [maintenance] = await db.execute(`
      SELECT mr.*, p.title as property_title
      FROM maintenance_requests mr
      JOIN property p ON mr.property_id = p.property_id
      WHERE mr.tenant_id = ? 
      ORDER BY mr.created_at DESC
    `, [tenant_id]);
    
    // Get rent schedules
    const [rentSchedules] = await db.execute(`
      SELECT rs.*, l.rent_amount
      FROM rent_schedules rs
      JOIN leases l ON rs.lease_id = l.lease_id
      WHERE l.tenant_id = ?
      ORDER BY rs.due_date DESC
      LIMIT 3
    `, [tenant_id]);
    
    // Get unread message count
    const [[unreadResult]] = await db.execute(`
      SELECT COUNT(*) as unread_count 
      FROM messages 
      WHERE receiver_id = ? AND is_read = 0
    `, [tenant_id]);
    
    res.json({ 
      lease, 
      payments, 
      maintenance, 
      rentSchedules,
      unreadCount: unreadResult.unread_count || 0
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get/update tenant profile
router.get("/profile/:id", async (req, res) => {
  try {
    const tenant_id = req.params.id;
    const [[profile]] = await db.execute("SELECT * FROM users WHERE user_id = ? AND role = 'tenant'", [tenant_id]);
    res.json({ profile });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put("/profile/:id", async (req, res) => {
  try {
    const tenant_id = req.params.id;
    const { first_name, last_name, phone } = req.body;
    await db.execute("UPDATE users SET first_name = ?, last_name = ?, phone = ? WHERE user_id = ? AND role = 'tenant'", [first_name, last_name, phone, tenant_id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Rent payment
router.post("/rent", async (req, res) => {
  try {
    const { lease_id, tenant_id, amount } = req.body;
    if (!lease_id || !tenant_id || !amount) return res.status(400).json({ error: "Missing required fields" });
    const [result] = await db.execute("INSERT INTO payments (lease_id, tenant_id, amount, payment_type, status) VALUES (?, ?, ?, 'rent', 'pending')", [lease_id, tenant_id, amount]);
    res.status(201).json({ message: "Rent payment created", id: result.insertId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Documents for tenant
router.get("/documents/:id", async (req, res) => {
  try {
    const tenant_id = req.params.id;
    // Get property_id from lease
    const [[lease]] = await db.execute("SELECT property_id FROM leases WHERE tenant_id = ? ORDER BY start_date DESC LIMIT 1", [tenant_id]);
    if (!lease) return res.json({ documents: [] });
    
    const [docs] = await db.execute(`
      SELECT 
        d.*,
        CONCAT(u.first_name, ' ', u.last_name) as uploaded_by_name,
        u.role as uploaded_by_role
      FROM documents d
      JOIN users u ON d.uploaded_by = u.user_id
      WHERE d.property_id = ? AND d.visible_to_tenant = 1
      ORDER BY d.created_at DESC
    `, [lease.property_id]);
    
    res.json({ documents: docs });
  } catch (error) {
    console.error('Documents fetch error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Maintenance requests
router.post("/maintenance", async (req, res) => {
  try {
    const { tenant_id, property_id, issue_description, photo_url, priority } = req.body;
    if (!tenant_id || !property_id || !issue_description) return res.status(400).json({ error: "Missing required fields" });
    const [result] = await db.execute("INSERT INTO maintenance_requests (tenant_id, property_id, issue_description, photo_url, priority) VALUES (?, ?, ?, ?, ?)", [tenant_id, property_id, issue_description, photo_url || null, priority || 'medium']);
    res.status(201).json({ message: "Maintenance request created", id: result.insertId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/maintenance/:id", async (req, res) => {
  try {
    const tenant_id = req.params.id;
    const [requests] = await db.execute(`
      SELECT 
        mr.*,
        p.title as property_title,
        p.address as property_address,
        u.first_name as supplier_first_name,
        u.last_name as supplier_last_name,
        u.phone as supplier_phone,
        u.email as supplier_email
      FROM maintenance_requests mr
      JOIN property p ON mr.property_id = p.property_id
      LEFT JOIN users u ON mr.supplier_id = u.user_id
      WHERE mr.tenant_id = ?
      ORDER BY mr.created_at DESC
    `, [tenant_id]);
    res.json({ requests });
  } catch (error) {
    console.error('Maintenance fetch error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Messaging (inbox/sent)
router.get("/messaging/inbox/:id", authenticateTenant, async (req, res) => {
  try {
    const tenant_id = req.params.id;
    const [messages] = await db.execute("SELECT * FROM messages WHERE receiver_id = ?", [tenant_id]);
    res.json({ messages });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/messaging/sent/:id", authenticateTenant, async (req, res) => {
  try {
    const tenant_id = req.params.id;
    const [messages] = await db.execute("SELECT * FROM messages WHERE sender_id = ?", [tenant_id]);
    res.json({ messages });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Send a message (tenant, supplier, investor)
router.post("/messaging/send", authenticateTenant, async (req, res) => {
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

// Payment history
router.get("/payments/:id", async (req, res) => {
  try {
    const tenant_id = req.params.id;
    const [payments] = await db.execute(`
      SELECT 
        p.*,
        l.rent_amount,
        l.due_date as lease_due_date,
        prop.title as property_title,
        prop.address as property_address
      FROM payments p
      LEFT JOIN leases l ON p.lease_id = l.lease_id
      LEFT JOIN property prop ON l.property_id = prop.property_id
      WHERE p.tenant_id = ?
      ORDER BY p.payment_date DESC
    `, [tenant_id]);
    res.json({ payments });
  } catch (error) {
    console.error('Payments fetch error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Reminders (rent due, maintenance)
router.get("/reminders/:id", async (req, res) => {
  try {
    const tenant_id = req.params.id;
    let reminders = [];
    
    // Rent due reminder
    const [[lease]] = await db.execute(`
      SELECT l.*, p.title as property_title, p.address as property_address
      FROM leases l
      JOIN property p ON l.property_id = p.property_id
      WHERE l.tenant_id = ? ORDER BY l.start_date DESC LIMIT 1
    `, [tenant_id]);
    
    if (lease) {
      // Calculate next rent due date
      const today = new Date();
      const dueDate = new Date(today.getFullYear(), today.getMonth(), lease.due_date);
      if (dueDate < today) {
        dueDate.setMonth(dueDate.getMonth() + 1);
      }
      
      reminders.push({ 
        type: "rent_due", 
        due_date: dueDate.toISOString().split('T')[0], 
        amount: lease.rent_amount,
        property_title: lease.property_title,
        property_address: lease.property_address,
        priority: "high"
      });
    }
    
    // Maintenance reminders
    const [pending] = await db.execute(`
      SELECT mr.*, p.title as property_title
      FROM maintenance_requests mr
      JOIN property p ON mr.property_id = p.property_id
      WHERE mr.tenant_id = ? AND mr.status != 'completed'
      ORDER BY mr.priority DESC, mr.created_at ASC
    `, [tenant_id]);
    
    if (pending.length > 0) {
      reminders.push({ 
        type: "maintenance_pending", 
        count: pending.length,
        requests: pending.slice(0, 3), // Show first 3 pending requests
        priority: "medium"
      });
    }
    
    // Lease expiry reminder
    if (lease && lease.end_date) {
      const endDate = new Date(lease.end_date);
      const daysUntilExpiry = Math.ceil((endDate - today) / (1000 * 60 * 60 * 24));
      
      if (daysUntilExpiry <= 30 && daysUntilExpiry > 0) {
        reminders.push({
          type: "lease_expiry",
          days_until_expiry: daysUntilExpiry,
          expiry_date: lease.end_date,
          property_title: lease.property_title,
          priority: daysUntilExpiry <= 7 ? "high" : "medium"
        });
      }
    }
    
    res.json({ reminders });
  } catch (error) {
    console.error('Reminders fetch error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Settings update
router.put("/settings/:id", async (req, res) => {
  try {
    const tenant_id = req.params.id;
    const { is_active } = req.body;
    await db.execute("UPDATE users SET is_active = ? WHERE user_id = ? AND role = 'tenant'", [is_active, tenant_id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get investor contact for tenant
router.get('/messaging/contacts/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    const search = req.query.search ? `%${req.query.search}%` : null;

    // Get investor linked to tenant's property
    let investorSQL = `
      SELECT 
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
      JOIN leases l ON p.property_id = l.property_id
      WHERE l.tenant_id = ? AND u.is_active = 1
    `;
    let investorParams = [userId, userId, userId, userId, userId, userId, userId, userId];
    if (search) {
      investorSQL += ' AND (u.first_name LIKE ? OR u.last_name LIKE ? OR u.email LIKE ?)';
      investorParams.push(search, search, search);
    }
    const [investors] = await db.execute(investorSQL, investorParams);

    // Get suppliers who have worked on tenant's property
    let supplierSQL = `
      SELECT DISTINCT
        u.user_id AS id, 
        CONCAT(u.first_name, ' ', u.last_name) AS name, 
        'supplier' AS role,
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
      JOIN maintenance_requests m ON u.user_id = m.supplier_id
      JOIN leases l ON m.property_id = l.property_id
      WHERE l.tenant_id = ? AND u.is_active = 1 AND u.role = 'supplier'
    `;
    let supplierParams = [userId, userId, userId, userId, userId, userId, userId, userId];
    if (search) {
      supplierSQL += ' AND (u.first_name LIKE ? OR u.last_name LIKE ? OR u.email LIKE ?)';
      supplierParams.push(search, search, search);
    }
    const [suppliers] = await db.execute(supplierSQL, supplierParams);

    // Combine and sort all contacts by last message time
    const allContacts = [...investors, ...suppliers];
    allContacts.sort((a, b) => {
      if (!a.last_message_time && !b.last_message_time) return 0;
      if (!a.last_message_time) return 1;
      if (!b.last_message_time) return 0;
      return new Date(b.last_message_time) - new Date(a.last_message_time);
    });

    res.json({ contacts: allContacts });
  } catch (error) {
    console.error('Error fetching investor contacts:', error);
    res.status(500).json({ error: error.message });
  }
});

// Send message (tenant to investor/supplier)
router.post("/messaging/send", async (req, res) => {
  try {
    const { sender_id, receiver_id, role, content, message_type = 'text' } = req.body;
    
    if (!sender_id || !receiver_id || !role || !content) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const [result] = await db.execute(
      `INSERT INTO messages (sender_id, receiver_id, content, message_type, created_at) 
       VALUES (?, ?, ?, ?, NOW())`,
      [sender_id, receiver_id, content, message_type]
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

// Get messages between tenant and investor
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

// Get tenant's lease information
router.get("/leases/:id", async (req, res) => {
  try {
    const tenant_id = req.params.id;
    const [leases] = await db.execute(`
      SELECT 
        l.*,
        p.title as property_title,
        p.address as property_address,
        p.city,
        p.state,
        p.zip_code,
        i.first_name as landlord_first_name,
        i.last_name as landlord_last_name,
        i.phone as landlord_phone,
        i.email as landlord_email
      FROM leases l
      LEFT JOIN property p ON l.property_id = p.property_id
      LEFT JOIN users i ON p.investor_id = i.user_id
      WHERE l.tenant_id = ?
      ORDER BY l.start_date DESC
    `, [tenant_id]);
    
    res.json({ leases });
  } catch (error) {
    console.error('Error fetching leases:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get tenant's lease by ID
router.get("/lease/:id", authenticateTenant, async (req, res) => {
  try {
    const [[lease]] = await db.execute(`
      SELECT 
        l.*,
        p.title as property_title,
        p.address as property_address,
        i.first_name as landlord_first_name,
        i.last_name as landlord_last_name,
        i.phone as landlord_phone,
        i.email as landlord_email
      FROM leases l
      LEFT JOIN property p ON l.property_id = p.property_id
      LEFT JOIN users i ON p.investor_id = i.user_id
      WHERE l.lease_id = ? AND l.tenant_id = ?
    `, [req.params.id, req.user.userId]);
    
    if (!lease) {
      return res.status(404).json({ error: "Lease not found" });
    }
    
    res.json({ lease });
  } catch (error) {
    console.error('Error fetching lease:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get tenant's rent schedules
router.get("/rent-schedules/:id", async (req, res) => {
  try {
    const tenant_id = req.params.id;
    const [schedules] = await db.execute(`
      SELECT 
        rs.*,
        l.rent_amount,
        l.due_date as lease_due_date,
        l.late_fee,
        l.late_fee_percentage,
        l.grace_period_days
      FROM rent_schedules rs
      JOIN leases l ON rs.lease_id = l.lease_id
      WHERE l.tenant_id = ?
      ORDER BY rs.due_date DESC
    `, [tenant_id]);
    
    res.json({ schedules });
  } catch (error) {
    console.error('Error fetching rent schedules:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get tenant's payment methods
router.get("/payment-methods/:id", async (req, res) => {
  try {
    const tenant_id = req.params.id;
    const [methods] = await db.execute(`
      SELECT * FROM tenant_payment_methods 
      WHERE tenant_id = ? AND is_active = 1
      ORDER BY is_default DESC
    `, [tenant_id]);
    
    res.json({ methods });
  } catch (error) {
    console.error('Error fetching payment methods:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get tenant's inventory items
router.get("/inventory/:id", async (req, res) => {
  try {
    const tenant_id = req.params.id;
    
    // Get property_id from lease
    const [[lease]] = await db.execute(`
      SELECT property_id FROM leases 
      WHERE tenant_id = ? ORDER BY start_date DESC LIMIT 1
    `, [tenant_id]);
    
    if (!lease) {
      return res.json({ inventory: [] });
    }
    
    const [inventory] = await db.execute(`
      SELECT 
        ii.*,
        CONCAT(u.first_name, ' ', u.last_name) as supplier_name,
        u.phone as supplier_phone,
        u.email as supplier_email
      FROM inventory_items ii
      LEFT JOIN users u ON ii.supplier_id = u.user_id
      WHERE ii.property_id = ?
      ORDER BY ii.created_at DESC
    `, [lease.property_id]);
    
    res.json({ inventory });
  } catch (error) {
    console.error('Error fetching inventory:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get tenant's notifications
router.get("/notifications/:id", async (req, res) => {
  try {
    const tenant_id = req.params.id;
    
    // Get recent messages
    const [messages] = await db.execute(`
      SELECT 
        m.*,
        CONCAT(s.first_name, ' ', s.last_name) as sender_name,
        s.role as sender_role
      FROM messages m
      JOIN users s ON m.sender_id = s.user_id
      WHERE m.receiver_id = ?
      ORDER BY m.created_at DESC
      LIMIT 10
    `, [tenant_id]);
    
    // Get maintenance updates
    const [maintenanceUpdates] = await db.execute(`
      SELECT 
        mr.request_id,
        mr.status,
        mr.updated_at,
        p.title as property_title
      FROM maintenance_requests mr
      JOIN property p ON mr.property_id = p.property_id
      WHERE mr.tenant_id = ? AND mr.status != 'pending'
      ORDER BY mr.updated_at DESC
      LIMIT 5
    `, [tenant_id]);
    
    const notifications = [
      ...messages.map(m => ({
        type: 'message',
        title: `New message from ${m.sender_name}`,
        content: m.content,
        timestamp: m.created_at,
        priority: 'medium'
      })),
      ...maintenanceUpdates.map(m => ({
        type: 'maintenance',
        title: `Maintenance update for ${m.property_title}`,
        content: `Status changed to ${m.status}`,
        timestamp: m.updated_at,
        priority: 'high'
      }))
    ];
    
    // Sort by timestamp
    notifications.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    res.json({ notifications: notifications.slice(0, 10) });
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ error: error.message });
  }
});

export { router as TenantPortalRouter };
