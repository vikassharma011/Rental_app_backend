
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
    // Get lease, payments, maintenance requests summary
    const [[lease]] = await db.execute("SELECT * FROM leases WHERE tenant_id = ? ORDER BY start_date DESC LIMIT 1", [tenant_id]);
    const [payments] = await db.execute("SELECT * FROM payments WHERE tenant_id = ?", [tenant_id]);
    const [maintenance] = await db.execute("SELECT * FROM maintenance_requests WHERE tenant_id = ?", [tenant_id]);
    res.json({ lease, payments, maintenance });
  } catch (error) {
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
    const [docs] = await db.execute("SELECT * FROM documents WHERE property_id = ? AND visible_to_tenant = 1", [lease.property_id]);
    res.json({ documents: docs });
  } catch (error) {
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
    const [requests] = await db.execute("SELECT * FROM maintenance_requests WHERE tenant_id = ?", [tenant_id]);
    res.json({ requests });
  } catch (error) {
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
    const [payments] = await db.execute("SELECT * FROM payments WHERE tenant_id = ?", [tenant_id]);
    res.json({ payments });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Reminders (rent due, maintenance)
router.get("/reminders/:id", async (req, res) => {
  try {
    const tenant_id = req.params.id;
    // Rent due reminder
    const [[lease]] = await db.execute("SELECT * FROM leases WHERE tenant_id = ? ORDER BY start_date DESC LIMIT 1", [tenant_id]);
    let reminders = [];
    if (lease) {
      reminders.push({ type: "rent_due", due_date: lease.due_date, amount: lease.rent_amount });
    }
    // Maintenance reminders
    const [pending] = await db.execute("SELECT * FROM maintenance_requests WHERE tenant_id = ? AND status != 'completed'", [tenant_id]);
    if (pending.length > 0) reminders.push({ type: "maintenance_pending", count: pending.length });
    res.json({ reminders });
  } catch (error) {
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

// Send message (tenant to investor)
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

export { router as TenantPortalRouter };
