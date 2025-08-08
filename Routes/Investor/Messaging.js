
import express from "express";
import { db } from "../../db.js";
const router = express.Router();

// Get contacts for investor messaging (active tenants and suppliers, with search)
router.get('/contacts/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    const search = req.query.search ? `%${req.query.search}%` : null;

    // Tenants linked to investor's properties
    let tenantSQL = `
      SELECT 
        u.user_id AS id, 
        CONCAT(u.first_name, ' ', u.last_name) AS name, 
        'tenant' AS role,
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
      JOIN leases l ON u.user_id = l.tenant_id
      JOIN property p ON l.property_id = p.property_id
      WHERE p.investor_id = ? AND u.is_active = 1
    `;
    let tenantParams = [userId, userId, userId, userId, userId, userId, userId, userId];
    if (search) {
      tenantSQL += ' AND (u.first_name LIKE ? OR u.last_name LIKE ? OR u.email LIKE ?)';
      tenantParams.push(search, search, search);
    }
    
    let tenants = [];
    try {
      const [tenantResults] = await db.execute(tenantSQL, tenantParams);
      tenants = tenantResults;
    } catch (error) {
      console.log('No tenants found or error:', error.message);
      tenants = [];
    }

    // Suppliers linked to investor (via property or maintenance)
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
      JOIN property p ON m.property_id = p.property_id
      WHERE p.investor_id = ? AND u.is_active = 1
    `;
    let supplierParams = [userId, userId, userId, userId, userId, userId, userId, userId];
    if (search) {
      supplierSQL += ' AND (u.first_name LIKE ? OR u.last_name LIKE ? OR u.email LIKE ?)';
      supplierParams.push(search, search, search);
    }
    
    let suppliers = [];
    try {
      const [supplierResults] = await db.execute(supplierSQL, supplierParams);
      suppliers = supplierResults;
    } catch (error) {
      console.log('No suppliers found or error:', error.message);
      suppliers = [];
    }

    const contacts = [...tenants, ...suppliers];
    
    // Sort by last message time (most recent first)
    contacts.sort((a, b) => {
      if (!a.last_message_time && !b.last_message_time) return 0;
      if (!a.last_message_time) return 1;
      if (!b.last_message_time) return -1;
      return new Date(b.last_message_time) - new Date(a.last_message_time);
    });

    // Transform contacts to include property field for frontend compatibility
    const transformedContacts = contacts.map(contact => ({
      ...contact,
      property: contact.property_name || 'Unknown Property',
      unreadCount: contact.unread_count || 0,
      lastMessage: contact.last_message || 'No messages yet',
      lastMessageTime: contact.last_message_time ? new Date(contact.last_message_time).toLocaleString() : 'Never'
    }));

    res.json({ contacts: transformedContacts });
  } catch (error) {
    console.error('Error fetching contacts:', error);
    res.status(500).json({ error: error.message });
  }
});

// Send a message (investor, tenant, supplier)
router.post("/send", async (req, res) => {
  try {
    const { sender_id, receiver_id, role, content, message, message_type = 'text' } = req.body;
    
    // Handle both 'content' and 'message' field names for compatibility
    const messageContent = content || message;
    
    if (!sender_id || !receiver_id || !messageContent) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const [result] = await db.execute(
      'INSERT INTO messages (sender_id, receiver_id, content, message_type, created_at) VALUES (?, ?, ?, ?, NOW())',
      [sender_id, receiver_id, messageContent, message_type]
    );

    const messageData = {
      id: result.insertId,
      sender_id,
      receiver_id,
      content: messageContent,
      message: messageContent, // Include both for compatibility
      message_type,
      created_at: new Date().toISOString(),
      is_read: false
    };

    res.status(201).json({ 
      message: messageData,
      success: true 
    });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get messages between logged-in user and a specific contact
router.get("/inbox/:id", async (req, res) => {
  try {
    const user_id = req.params.id;
    const contact_id = req.query.contact_id;

    if (!contact_id) {
      // If no contact_id provided, return empty messages array
      return res.json({ messages: [] });
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

    // Transform messages to include both 'content' and 'message' fields for compatibility
    const transformedMessages = messages.map(msg => ({
      ...msg,
      message: msg.content, // Add 'message' field for frontend compatibility
      id: msg.message_id || msg.id // Handle different ID field names
    }));

    res.json({ messages: transformedMessages });
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get messages sent by a user (sent)
router.get("/sent/:id", async (req, res) => {
  try {
    const user_id = req.params.id;
    const [messages] = await db.execute(
      `SELECT m.*, 
              CONCAT(s.first_name, ' ', s.last_name) as sender_name,
              CONCAT(r.first_name, ' ', r.last_name) as receiver_name
       FROM messages m
       JOIN users s ON m.sender_id = s.user_id
       JOIN users r ON m.receiver_id = r.user_id
       WHERE m.sender_id = ? 
       ORDER BY m.created_at DESC`,
      [user_id]
    );
    res.json({ messages });
  } catch (error) {
    console.error('Error fetching sent messages:', error);
    res.status(500).json({ error: error.message });
  }
});

// Mark messages as read
router.put("/read/:userId", async (req, res) => {
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
router.get("/unread/:userId", async (req, res) => {
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

export { router as MessagingRouter };
