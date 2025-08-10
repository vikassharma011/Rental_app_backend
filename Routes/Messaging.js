import express from "express";
import { db } from "../db.js";
const router = express.Router();

// Test endpoint to verify API is working
router.get('/test', (req, res) => {
  res.json({ 
    message: 'Messaging API is working!',
    timestamp: new Date().toISOString()
  });
});

// Debug endpoint to check database relationships
router.get('/debug/:userId/:role', async (req, res) => {
  try {
    const { userId, role } = req.params;
    console.log('Debug request for user:', userId, 'role:', role);
    
    let result = {};
    
    if (role === 'investor') {
      // Check if investor has properties
      const [properties] = await db.execute(
        'SELECT property_id, title FROM property WHERE investor_id = ?',
        [userId]
      );
      result.properties = properties;
      
      // Check if properties have tenants
      if (properties.length > 0) {
        const propertyIds = properties.map(p => p.property_id);
        const [tenants] = await db.execute(
          'SELECT l.tenant_id, u.first_name, u.last_name FROM leases l JOIN users u ON l.tenant_id = u.user_id WHERE l.property_id IN (?)',
          [propertyIds]
        );
        result.tenants = tenants;
      }
    } else if (role === 'tenant') {
      // Check if tenant has leases
      const [leases] = await db.execute(
        'SELECT l.property_id, p.title, p.investor_id FROM leases l JOIN property p ON l.property_id = p.property_id WHERE l.tenant_id = ?',
        [userId]
      );
      result.leases = leases;
      
      // Check if tenant has maintenance requests with suppliers
      const [maintenance] = await db.execute(
        'SELECT mr.supplier_id, u.first_name, u.last_name FROM maintenance_requests mr JOIN users u ON mr.supplier_id = u.user_id WHERE mr.tenant_id = ?',
        [userId]
      );
      result.maintenance = maintenance;
    }
    
    res.json(result);
  } catch (error) {
    console.error('Debug error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get contacts for any user type (investor, tenant, supplier)
router.get('/contacts/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    const userRole = req.query.role; // investor, tenant, supplier
    const search = req.query.search ? `%${req.query.search}%` : null;

    console.log('=== CONTACTS REQUEST ===');
    console.log('User ID:', userId);
    console.log('User Role:', userRole);
    console.log('Search Query:', search);

    if (!userRole) {
      return res.status(400).json({ error: 'Role parameter is required' });
    }

    let contacts = [];

    if (userRole === 'investor') {
      console.log('Fetching investor contacts...');
      contacts = await getInvestorContacts(userId, search);
    } else if (userRole === 'tenant') {
      console.log('Fetching tenant contacts...');
      contacts = await getTenantContacts(userId, search);
    } else if (userRole === 'supplier') {
      console.log('Fetching supplier contacts...');
      contacts = await getSupplierContacts(userId, search);
    } else {
      return res.status(400).json({ error: 'Invalid role. Must be investor, tenant, or supplier' });
    }

    console.log('Raw contacts found:', contacts.length);
    console.log('Sample contact:', contacts[0]);

    // Sort by last message time (most recent first)
    contacts.sort((a, b) => {
      if (!a.last_message_time && !b.last_message_time) return 0;
      if (!a.last_message_time) return 1;
      if (!b.last_message_time) return -1;
      return new Date(b.last_message_time) - new Date(a.last_message_time);
    });

    // Transform contacts for frontend compatibility
    const transformedContacts = contacts.map(contact => ({
      ...contact,
      property: contact.property_name || 'Unknown Property',
      unreadCount: contact.unread_count || 0,
      lastMessage: contact.last_message || 'No messages yet',
      lastMessageTime: contact.last_message_time ? new Date(contact.last_message_time).toLocaleString() : 'Never'
    }));

    console.log('Transformed contacts:', transformedContacts.length);
    console.log('=== END CONTACTS REQUEST ===');
    
    res.json({ contacts: transformedContacts });
  } catch (error) {
    console.error('Error fetching contacts:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get contacts for investor
async function getInvestorContacts(investorId, search) {
  const contacts = [];
  console.log('Getting contacts for investor ID:', investorId);

  // Get tenants - Simplified query
  let tenantSQL = `
    SELECT DISTINCT
      u.user_id AS id, 
      CONCAT(u.first_name, ' ', u.last_name) AS name, 
      'tenant' AS role,
      u.email,
      p.property_id,
      p.title AS property_name,
      (SELECT COUNT(*) FROM messages m WHERE m.sender_id = u.user_id AND m.receiver_id = ? AND m.is_read = 0) AS unread_count,
      (SELECT m.content FROM messages m WHERE ((m.sender_id = u.user_id AND m.receiver_id = ?) OR (m.sender_id = ? AND m.receiver_id = u.user_id)) ORDER BY m.created_at DESC LIMIT 1) AS last_message,
      (SELECT m.created_at FROM messages m WHERE ((m.sender_id = u.user_id AND m.receiver_id = ?) OR (m.sender_id = ? AND m.receiver_id = u.user_id)) ORDER BY m.created_at DESC LIMIT 1) AS last_message_time
    FROM users u
    JOIN leases l ON u.user_id = l.tenant_id
    JOIN property p ON l.property_id = p.property_id
    WHERE p.investor_id = ? AND u.is_active = 1 AND u.role = 'tenant'
  `;
  let tenantParams = [investorId, investorId, investorId, investorId, investorId, investorId];
  
  if (search) {
    tenantSQL += ' AND (u.first_name LIKE ? OR u.last_name LIKE ? OR u.email LIKE ?)';
    tenantParams.push(search, search, search);
  }

  try {
    console.log('Executing tenant query with params:', tenantParams);
    const [tenants] = await db.execute(tenantSQL, tenantParams);
    console.log('Found tenants:', tenants.length);
    contacts.push(...tenants);
  } catch (error) {
    console.error('Error fetching tenants:', error.message);
  }

  // Get suppliers - Simplified query
  let supplierSQL = `
    SELECT DISTINCT
      u.user_id AS id, 
      CONCAT(u.first_name, ' ', u.last_name) AS name, 
      'supplier' AS role,
      u.email,
      p.property_id,
      p.title AS property_name,
      0 AS unread_count,
      'No messages yet' AS last_message,
      NULL AS last_message_time
    FROM users u
    JOIN maintenance_requests m ON u.user_id = m.supplier_id
    JOIN property p ON m.property_id = p.property_id
    WHERE p.investor_id = ? AND u.is_active = 1 AND u.role = 'supplier'
  `;
  let supplierParams = [investorId];
  
  if (search) {
    supplierSQL += ' AND (u.first_name LIKE ? OR u.last_name LIKE ? OR u.email LIKE ?)';
    supplierParams.push(search, search, search);
  }

  try {
    console.log('Executing supplier query with params:', supplierParams);
    const [suppliers] = await db.execute(supplierSQL, supplierParams);
    console.log('Found suppliers:', suppliers.length);
    contacts.push(...suppliers);
  } catch (error) {
    console.error('Error fetching suppliers:', error.message);
  }

  console.log('Total contacts for investor:', contacts.length);
  return contacts;
}

// Get contacts for tenant
async function getTenantContacts(tenantId, search) {
  const contacts = [];
  console.log('Getting contacts for tenant ID:', tenantId);

  // Get investor - Simplified query
  let investorSQL = `
    SELECT DISTINCT
      u.user_id AS id, 
      CONCAT(u.first_name, ' ', u.last_name) AS name, 
      'investor' AS role,
      u.email,
      p.property_id,
      p.title AS property_name,
      0 AS unread_count,
      'No messages yet' AS last_message,
      NULL AS last_message_time
    FROM users u
    JOIN property p ON u.user_id = p.investor_id
    JOIN leases l ON p.property_id = l.property_id
    WHERE l.tenant_id = ? AND u.is_active = 1 AND u.role = 'investor'
  `;
  let investorParams = [tenantId];
  
  if (search) {
    investorSQL += ' AND (u.first_name LIKE ? OR u.last_name LIKE ? OR u.email LIKE ?)';
    investorParams.push(search, search, search);
  }

  try {
    console.log('Executing investor query with params:', investorParams);
    const [investors] = await db.execute(investorSQL, investorParams);
    console.log('Found investors:', investors.length);
    contacts.push(...investors);
  } catch (error) {
    console.error('Error fetching investors:', error.message);
  }

  // Get suppliers - Simplified query
  let supplierSQL = `
    SELECT DISTINCT
      u.user_id AS id, 
      CONCAT(u.first_name, ' ', u.last_name) AS name, 
      'supplier' AS role,
      u.email,
      p.property_id,
      p.title AS property_name,
      0 AS unread_count,
      'No messages yet' AS last_message,
      NULL AS last_message_time
    FROM users u
    JOIN maintenance_requests m ON u.user_id = m.supplier_id
    JOIN property p ON m.property_id = p.property_id
    JOIN leases l ON p.property_id = l.property_id
    WHERE l.tenant_id = ? AND u.is_active = 1 AND u.role = 'supplier'
  `;
  let supplierParams = [tenantId];
  
  if (search) {
    supplierSQL += ' AND (u.first_name LIKE ? OR u.last_name LIKE ? OR u.email LIKE ?)';
    supplierParams.push(search, search, search);
  }

  try {
    console.log('Executing supplier query with params:', supplierParams);
    const [suppliers] = await db.execute(supplierSQL, supplierParams);
    console.log('Found suppliers:', suppliers.length);
    contacts.push(...suppliers);
  } catch (error) {
    console.error('Error fetching suppliers:', error.message);
  }

  console.log('Total contacts for tenant:', contacts.length);
  return contacts;
}

// Get contacts for supplier
async function getSupplierContacts(supplierId, search) {
  const contacts = [];

  // Get investors
  let investorSQL = `
    SELECT DISTINCT
      u.user_id AS id, 
      CONCAT(u.first_name, ' ', u.last_name) AS name, 
      'investor' AS role,
      u.email,
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
    WHERE m.supplier_id = ? AND u.is_active = 1 AND u.role = 'investor'
  `;
  let investorParams = [supplierId, supplierId, supplierId, supplierId, supplierId, supplierId, supplierId, supplierId];
  
  if (search) {
    investorSQL += ' AND (u.first_name LIKE ? OR u.last_name LIKE ? OR u.email LIKE ?)';
    investorParams.push(search, search, search);
  }

  try {
    const [investors] = await db.execute(investorSQL, investorParams);
    contacts.push(...investors);
  } catch (error) {
    console.log('No investors found:', error.message);
  }

  // Get tenants
  let tenantSQL = `
    SELECT DISTINCT
      u.user_id AS id, 
      CONCAT(u.first_name, ' ', u.last_name) AS name, 
      'tenant' AS role,
      u.email,
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
    JOIN maintenance_requests m ON p.property_id = m.property_id
    WHERE m.supplier_id = ? AND u.is_active = 1 AND u.role = 'tenant'
  `;
  let tenantParams = [supplierId, supplierId, supplierId, supplierId, supplierId, supplierId, supplierId, supplierId];
  
  if (search) {
    tenantSQL += ' AND (u.first_name LIKE ? OR u.last_name LIKE ? OR u.email LIKE ?)';
    tenantParams.push(search, search, search);
  }

  try {
    const [tenants] = await db.execute(tenantSQL, tenantParams);
    contacts.push(...tenants);
  } catch (error) {
    console.log('No tenants found:', error.message);
  }

  return contacts;
}

// Send a message
router.post("/send", async (req, res) => {
  try {
    const { sender_id, receiver_id, content, message, message_type = 'text' } = req.body;
    
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
