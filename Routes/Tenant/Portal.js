
import express from "express";
import { db } from "../../db.js";
import jwt from "jsonwebtoken";
import multer from "multer";
import path from "path";
import fs from "fs";

const router = express.Router();

// Database connection health check
async function checkDatabaseConnection() {
  try {
    await db.execute('SELECT 1');
    console.log('✅ Database connection healthy');
    return true;
  } catch (error) {
    console.error('❌ Database connection error:', error.message);
    if (error.code === 'ER_USER_LIMIT_REACHED') {
      console.error('🚨 Database connection limit exceeded. Consider implementing connection pooling or reducing concurrent requests.');
    }
    return false;
  }
}

// Check database connection on startup
checkDatabaseConnection();

// Database operation wrapper with error handling
async function executeWithRetry(query, params, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Check connection health before executing
      if (attempt > 1) {
        await checkDatabaseConnection();
      }
      
      const result = await db.execute(query, params);
      return result;
    } catch (error) {
      console.error(`Database execution attempt ${attempt} failed:`, error.message);
      
      if (error.code === 'ER_USER_LIMIT_REACHED') {
        console.error('🚨 Connection limit reached, waiting before retry...');
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt)); // Exponential backoff
        continue;
      }
      
      if (error.code === 'ER_WRONG_ARGUMENTS') {
        console.error('🚨 SQL parameter error:', error.message);
        console.error('Query:', query);
        console.error('Params:', params);
        console.error('Param types:', params.map(p => typeof p));
        throw new Error(`SQL parameter error: ${error.message}`);
      }
      
      if (attempt === maxRetries) {
        throw error;
      }
      
      // Wait before retry for other errors
      await new Promise(resolve => setTimeout(resolve, 500 * attempt));
    }
  }
  throw new Error('Max retries exceeded for database operation');
}

// Ensure uploads directory exists
const uploadsDir = 'uploads/maintenance-photos/';
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.round(Math.random() * 1E9));
    cb(null, 'maintenance-' + req.params.tenantId + '-' + uniqueSuffix + path.extname(file.originalname));
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
    const { page = 1, limit = 10, status, payment_type } = req.query;
    
    console.log('Payment History Request:', { tenant_id, page, limit, status, payment_type });
    
    // Validate and sanitize parameters
    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 10)); // Max 100 items
    const offset = (pageNum - 1) * limitNum;

    console.log('Sanitized params:', { pageNum, limitNum, offset });

    let whereClause = "WHERE p.tenant_id = ?";
    let params = [tenant_id];

    if (status) {
      whereClause += " AND p.status = ?";
      params.push(status);
    }

    if (payment_type) {
      whereClause += " AND p.payment_type = ?";
      params.push(payment_type);
    }

    console.log('Where clause:', whereClause);
    console.log('Params for count:', params);

    // Get total count first - ensure consistent parameter types
    const countQuery = `SELECT COUNT(*) as total FROM payments p ${whereClause}`;
    console.log('Count query:', countQuery);
    
    const countParams = [
      tenant_id.toString(),
      ...(status ? [status] : []),
      ...(payment_type ? [payment_type] : [])
    ];
    
    const [[countResult]] = await executeWithRetry(countQuery, countParams);
    console.log('Count result:', countResult);

    const total = countResult.total;

    // If no payments found, return empty result
    if (total === 0) {
      console.log('No payments found, returning empty result');
      return res.json({
        payments: [],
        pagination: {
          current_page: pageNum,
          total_pages: 0,
          total_items: 0,
          items_per_page: limitNum
        }
      });
    }

    // Get payments with proper parameter handling
    const paymentsQuery = `
      SELECT 
        p.payment_id,
        p.lease_id,
        p.tenant_id,
        p.amount,
        p.late_fee_amount,
        p.total_amount,
        p.payment_date,
        p.due_date,
        p.remarks,
        p.receipt_url,
        p.payment_type,
        p.payment_method,
        p.transaction_id,
        p.status,
        p.created_at,
        p.updated_at,
        l.rent_amount,
        l.start_date as lease_start_date,
        l.end_date as lease_end_date
      FROM payments p
      LEFT JOIN leases l ON p.lease_id = l.lease_id
      ${whereClause}
      ORDER BY p.payment_date DESC
      LIMIT ? OFFSET ?
    `;
    
    // Ensure parameters are properly typed for MySQL - convert all to strings for consistency
    const finalParams = [
      tenant_id.toString(), // Ensure tenant_id is string
      ...(status ? [status] : []),
      ...(payment_type ? [payment_type] : []),
      limitNum.toString(), // Convert to string
      offset.toString()    // Convert to string
    ];
    
    console.log('Payments query:', paymentsQuery);
    console.log('Final params:', finalParams);
    console.log('Parameter types:', finalParams.map(p => typeof p));

    const [payments] = await executeWithRetry(paymentsQuery, finalParams);
    console.log('Payments result count:', payments.length);

    const response = {
      payments,
      pagination: {
        current_page: pageNum,
        total_pages: Math.ceil(total / limitNum),
        total_items: total,
        items_per_page: limitNum
      }
    };

    console.log('Sending response:', response);
    res.json(response);
    
  } catch (error) {
    console.error('Error getting payment history:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({ 
      error: "Failed to fetch payment history",
      details: error.message,
      stack: error.stack
    });
  }
});

// Get rent schedules with payment status
router.get("/rent-schedules/:id", authenticateTenant, async (req, res) => {
  try {
    const tenant_id = req.params.id;
    
    const [schedules] = await db.execute(`
      SELECT 
        rs.*,
        l.rent_amount,
        l.start_date as lease_start_date,
        l.end_date as lease_end_date
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

// Upload maintenance photo
router.post("/maintenance/upload-photo/:tenantId", upload.single('photo'), async (req, res) => {
  try {
    const { tenantId } = req.params;
    
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // Generate the file URL (in production, this would be a CDN URL)
    const fileUrl = `${req.protocol}://${req.get('host')}/uploads/maintenance-photos/${req.file.filename}`;
    
    res.json({ 
      message: "Photo uploaded successfully",
      photo_url: fileUrl
    });
  } catch (error) {
    console.error("Error uploading maintenance photo:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Change tenant password
router.put("/profile/:id/change-password", authenticateTenant, async (req, res) => {
  try {
    const { id } = req.params;
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) {
      return res.status(400).json({ error: "Old and new passwords are required" });
    }
    const [[user]] = await db.execute(
      "SELECT password_hash FROM users WHERE user_id = ? AND role = 'tenant'",
      [id]
    );
    if (!user) return res.status(404).json({ error: "User not found" });
    if (user.password_hash !== oldPassword) {
      return res.status(400).json({ error: "Current password is incorrect" });
    }
    await db.execute(
      "UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND role = 'tenant'",
      [newPassword, id]
    );
    res.json({ message: "Password changed successfully" });
  } catch (error) {
    console.error("Error changing tenant password:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Upload tenant profile picture (accepts Cloudinary URL)
router.post("/profile/:id/upload-picture", authenticateTenant, async (req, res) => {
  try {
    const { id } = req.params;
    const { file_url } = req.body || {};
    if (!file_url) return res.status(400).json({ error: "file_url is required" });
    await db.execute(
      "UPDATE users SET profile_picture_url = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND role = 'tenant'",
      [file_url, id]
    );
    res.json({ message: "Profile picture updated", profile_picture_url: file_url });
  } catch (error) {
    console.error("Error uploading tenant profile picture:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Error handling middleware for multer
router.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum size is 5MB.' });
    }
    return res.status(400).json({ error: error.message });
  }
  if (error) {
    return res.status(400).json({ error: error.message });
  }
  next();
});

// Get tenant's maintenance request by ID with detailed information
router.get("/maintenance/request/:requestId", async (req, res) => {
  try {
    const request_id = req.params.requestId;
    const [[request]] = await db.execute(`
      SELECT 
        mr.*,
        p.title as property_title,
        p.address as property_address,
        u.first_name as supplier_first_name,
        u.last_name as supplier_last_name,
        u.phone as supplier_phone,
        u.email as supplier_email,
        l.rent_amount
      FROM maintenance_requests mr
      JOIN property p ON mr.property_id = p.property_id
      LEFT JOIN users u ON mr.supplier_id = u.user_id
      LEFT JOIN leases l ON mr.property_id = l.property_id AND l.tenant_id = mr.tenant_id
      WHERE mr.request_id = ?
    `, [request_id]);
    
    if (!request) {
      return res.status(404).json({ error: "Maintenance request not found" });
    }
    
    // Get quotes for this request
    const [quotes] = await db.execute(`
      SELECT 
        mq.*,
        u.first_name as supplier_first_name,
        u.last_name as supplier_last_name,
        u.phone as supplier_phone,
        u.email as supplier_email
      FROM maintenance_quotes mq
      JOIN users u ON mq.supplier_id = u.user_id
      WHERE mq.request_id = ?
      ORDER BY mq.amount ASC
    `, [request_id]);
    
    res.json({ 
      request, 
      quotes,
      total_quotes: quotes.length,
      lowest_quote: quotes.length > 0 ? Math.min(...quotes.map(q => q.amount)) : null
    });
  } catch (error) {
    console.error('Error fetching maintenance request:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get tenant's maintenance history with pagination
router.get("/maintenance/history/:id", async (req, res) => {
  try {
    const tenant_id = req.params.id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
    
    // Get total count - ensure consistent parameter types
    const [[countResult]] = await db.execute(
      "SELECT COUNT(*) as total FROM maintenance_requests WHERE tenant_id = ?",
      [tenant_id.toString()]
    );
    
    // Get paginated results - ensure consistent parameter types
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
      LIMIT ? OFFSET ?
    `, [tenant_id.toString(), limit.toString(), offset.toString()]);
    
    res.json({ 
      requests,
      pagination: {
        current_page: page,
        total_pages: Math.ceil(countResult.total / limit),
        total_items: countResult.total,
        items_per_page: limit
      }
    });
  } catch (error) {
    console.error('Error fetching maintenance history:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get tenant's payment history with pagination and filters
router.get("/payments/history/:id", async (req, res) => {
  try {
    const tenant_id = req.params.id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
    const status = req.query.status; // optional filter
    const payment_type = req.query.payment_type; // optional filter
    
    let whereClause = "WHERE p.tenant_id = ?";
    let params = [tenant_id];
    
    if (status) {
      whereClause += " AND p.status = ?";
      params.push(status);
    }
    
    if (payment_type) {
      whereClause += " AND p.payment_type = ?";
      params.push(payment_type);
    }
    
    // Get total count - ensure consistent parameter types
    const countParams = [
      tenant_id.toString(),
      ...(status ? [status] : []),
      ...(payment_type ? [payment_type] : [])
    ];
    
    const [[countResult]] = await db.execute(
      `SELECT COUNT(*) as total FROM payments p ${whereClause}`,
      countParams
    );
    
    // Get paginated results - ensure consistent parameter types
    const finalParams = [
      tenant_id.toString(),
      ...(status ? [status] : []),
      ...(payment_type ? [payment_type] : []),
      limit.toString(),
      offset.toString()
    ];
    
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
      ${whereClause}
      ORDER BY p.payment_date DESC
      LIMIT ? OFFSET ?
    `, finalParams);
    
    res.json({ 
      payments,
      pagination: {
        current_page: page,
        total_pages: Math.ceil(countResult.total / limit),
        total_items: countResult.total,
        items_per_page: limit
      }
    });
  } catch (error) {
    console.error('Error fetching payment history:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get tenant's dashboard analytics
router.get("/dashboard/analytics/:id", async (req, res) => {
  try {
    const tenant_id = req.params.id;
    
    // Get current month's data
    const currentMonth = new Date().getMonth() + 1;
    const currentYear = new Date().getFullYear();
    
    // Monthly payment total
    const [[monthlyPayment]] = await db.execute(`
      SELECT COALESCE(SUM(amount), 0) as total
      FROM payments 
      WHERE tenant_id = ? AND MONTH(payment_date) = ? AND YEAR(payment_date) = ? AND status = 'completed'
    `, [tenant_id, currentMonth, currentYear]);
    
    // Maintenance requests this month
    const [[monthlyMaintenance]] = await db.execute(`
      SELECT COUNT(*) as total
      FROM maintenance_requests 
      WHERE tenant_id = ? AND MONTH(created_at) = ? AND YEAR(created_at) = ?
    `, [tenant_id, currentMonth, currentYear]);
    
    // Completed maintenance this month
    const [[completedMaintenance]] = await db.execute(`
      SELECT COUNT(*) as total
      FROM maintenance_requests 
      WHERE tenant_id = ? AND MONTH(updated_at) = ? AND YEAR(updated_at) = ? AND status = 'completed'
    `, [tenant_id, currentMonth, currentYear]);
    
    // Unread messages
    const [[unreadMessages]] = await db.execute(`
      SELECT COUNT(*) as total
      FROM messages 
      WHERE receiver_id = ? AND is_read = 0
    `, [tenant_id]);
    
    // Payment trend (last 6 months)
    const [paymentTrend] = await db.execute(`
      SELECT 
        DATE_FORMAT(payment_date, '%Y-%m') as month,
        SUM(amount) as total
      FROM payments 
      WHERE tenant_id = ? AND status = 'completed' AND payment_date >= DATE_SUB(NOW(), INTERVAL 6 MONTH)
      GROUP BY DATE_FORMAT(payment_date, '%Y-%m')
      ORDER BY month DESC
    `, [tenant_id]);
    
    res.json({
      current_month: {
        payments: monthlyPayment.total,
        maintenance_requests: monthlyMaintenance.total,
        completed_maintenance: completedMaintenance.total,
        unread_messages: unreadMessages.total
      },
      payment_trend: paymentTrend,
      total_maintenance_requests: monthlyMaintenance.total,
      total_payments: monthlyPayment.total
    });
  } catch (error) {
    console.error('Error fetching dashboard analytics:', error);
    res.status(500).json({ error: error.message });
  }
});

// Email notification function for payment confirmation
async function sendPaymentConfirmationEmail(tenant_id, payment_id, amount, transaction_id, payment_method) {
  try {
    // Get tenant details
    const [[tenant]] = await db.execute(`
      SELECT first_name, last_name, email FROM tenants WHERE tenant_id = ?
    `, [tenant_id]);

    if (!tenant) {
      console.error('Tenant not found for email notification');
      return;
    }

    // Get payment details
    const [[payment]] = await db.execute(`
      SELECT p.*, l.rent_amount, prop.title as property_title
      FROM payments p
      JOIN leases l ON p.lease_id = l.lease_id
      JOIN property prop ON l.property_id = prop.property_id
      WHERE p.payment_id = ?
    `, [payment_id]);

    if (!payment) {
      console.error('Payment not found for email notification');
      return;
    }

    // For now, just log the email details (you can integrate with actual email service later)
    const emailData = {
      to: tenant.email,
      subject: 'Rent Payment Confirmation',
      tenant_name: `${tenant.first_name} ${tenant.last_name}`,
      payment_amount: amount,
      transaction_id: transaction_id,
      payment_method: payment_method,
      payment_date: new Date().toLocaleDateString('en-IN'),
      property: payment.property_title,
      payment_id: payment_id
    };

    console.log('📧 Payment Confirmation Email Details:');
    console.log('To:', emailData.to);
    console.log('Subject:', emailData.subject);
    console.log('Tenant:', emailData.tenant_name);
    console.log('Amount:', `₹${emailData.payment_amount}`);
    console.log('Transaction ID:', emailData.transaction_id);
    console.log('Payment Method:', emailData.payment_method);
    console.log('Property:', emailData.property);

    // TODO: Integrate with actual email service (SendGrid, Nodemailer, etc.)
    // For now, we'll just log the email content
    const emailContent = `
Dear ${emailData.tenant_name},

Thank you for your rent payment!

Payment Details:
- Amount: ₹${emailData.payment_amount}
- Transaction ID: ${emailData.transaction_id}
- Payment Method: ${emailData.payment_method}
- Date: ${emailData.payment_date}
- Property: ${emailData.property}
- Payment ID: ${emailData.payment_id}

Your payment has been processed successfully. Please keep this confirmation for your records.

Best regards,
Rental Management Team
    `;

    console.log('📧 Email Content:');
    console.log(emailContent);

    // In a real implementation, you would send this email using a service like:
    // - SendGrid
    // - Nodemailer
    // - AWS SES
    // - Mailgun
    
    return true;
    
  } catch (error) {
    console.error('Error sending payment confirmation email:', error);
    throw error;
  }
}

export { router as TenantPortalRouter };
