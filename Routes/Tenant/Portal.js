
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
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback-secret');
    if (decoded.role !== "tenant") {
      return res.status(403).json({ success: false, message: "Only tenants allowed" });
    }
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ success: false, message: "Invalid token" });
  }
}

// Test endpoint to verify routing is working
router.get("/test", (req, res) => {
  res.json({ 
    message: "Tenant portal is working!", 
    timestamp: new Date().toISOString(),
    endpoints: [
      "/dashboard/:id",
      "/profile/:id", 
      "/maintenance/:id",
      "/payments/:id",
      "/payment-history/:id",
      "/rent-status/:id",
      "/auto-pay/:id",
      "/reminders/:id",
      "/settings/:id"
    ]
  });
});

// Health check endpoint
router.get("/health", (req, res) => {
  res.json({ 
    status: "healthy", 
    service: "tenant-portal",
    timestamp: new Date().toISOString()
  });
});

// Database test endpoint
router.get("/db-test", async (req, res) => {
  try {
    const [result] = await db.execute('SELECT 1 as test, NOW() as timestamp');
    res.json({ 
      status: "database_connected", 
      result: result[0],
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Database test failed:', error);
    res.status(500).json({ 
      status: "database_error", 
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

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
    const tenant_id = parseInt(req.params.id);
    
    // Validate tenant_id
    if (isNaN(tenant_id)) {
      return res.status(400).json({ error: 'Invalid tenant ID' });
    }
    
    // Get recent messages
    const [messages] = await executeWithRetry(`
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
    const [maintenanceUpdates] = await executeWithRetry(`
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
    const tenantId = parseInt(req.params.tenantId);
    
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

// Get tenant's maintenance request by ID with detailed information
router.get("/maintenance/request/:requestId", async (req, res) => {
  try {
    const request_id = parseInt(req.params.requestId);
    
    if (isNaN(request_id)) {
      return res.status(400).json({ error: 'Invalid request ID' });
    }
    
    const [request] = await executeWithRetry(`
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
    
    if (request.length === 0) {
      return res.status(404).json({ error: "Maintenance request not found" });
    }
    
    // Get quotes for this request
    const [quotes] = await executeWithRetry(`
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
      request: request[0], 
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
    const tenant_id = parseInt(req.params.id);
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
    
    // Validate tenant_id
    if (isNaN(tenant_id)) {
      return res.status(400).json({ error: 'Invalid tenant ID' });
    }
    
    // Get total count
    const [countResult] = await executeWithRetry(
      "SELECT COUNT(*) as total FROM maintenance_requests WHERE tenant_id = ?",
      [tenant_id]
    );
    
    // Get paginated results
    const [requests] = await executeWithRetry(`
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
    `, [tenant_id, limit, offset]);
    
    res.json({ 
      requests,
      pagination: {
        current_page: page,
        total_pages: Math.ceil(countResult[0].total / limit),
        total_items: countResult[0].total,
        items_per_page: limit
      }
    });
  } catch (error) {
    console.error('Error fetching maintenance history:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get tenant's reminders
router.get("/reminders/:id", async (req, res) => {
  try {
    const tenant_id = parseInt(req.params.id);
    
    // Validate tenant_id
    if (isNaN(tenant_id)) {
      return res.status(400).json({ error: 'Invalid tenant ID' });
    }
    
    // Get rent due reminders
    const [rentReminders] = await executeWithRetry(`
      SELECT 
        'rent_due' as type,
        'Rent Due' as title,
        CONCAT('Rent payment of ₹', FORMAT(l.rent_amount, 0), ' is due on ', DATE_FORMAT(DATE_ADD(CURDATE(), INTERVAL 1 DAY), '%d %b %Y')) as message,
        DATE_ADD(CURDATE(), INTERVAL 1 DAY) as due_date,
        'high' as priority,
        l.lease_id as reference_id,
        'pending' as status
      FROM leases l
      WHERE l.tenant_id = ? 
      AND l.end_date >= CURDATE()
      AND NOT EXISTS (
        SELECT 1 FROM payments p 
        WHERE p.lease_id = l.lease_id 
        AND p.payment_type = 'rent' 
        AND MONTH(p.payment_date) = MONTH(CURDATE())
        AND YEAR(p.payment_date) = YEAR(CURDATE())
      )
    `, [tenant_id]);

    // Get maintenance reminders
    const [maintenanceReminders] = await executeWithRetry(`
      SELECT 
        'maintenance' as type,
        'Maintenance Update' as title,
        CONCAT('Maintenance request #', mr.request_id, ' needs attention') as message,
        mr.created_at as due_date,
        mr.priority,
        mr.request_id as reference_id,
        mr.status
      FROM maintenance_requests mr
      WHERE mr.tenant_id = ? 
      AND mr.status IN ('pending', 'assigned', 'in_progress')
      ORDER BY mr.created_at DESC
      LIMIT 5
    `, [tenant_id]);

    // Get lease expiry reminders
    const [leaseReminders] = await executeWithRetry(`
      SELECT 
        'lease_expiry' as type,
        'Lease Expiry' as title,
        CONCAT('Your lease expires on ', DATE_FORMAT(l.end_date, '%d %b %Y')) as message,
        l.end_date as due_date,
        CASE 
          WHEN DATEDIFF(l.end_date, CURDATE()) <= 30 THEN 'high'
          WHEN DATEDIFF(l.end_date, CURDATE()) <= 60 THEN 'medium'
          ELSE 'low'
        END as priority,
        l.lease_id as reference_id,
        'active' as status
      FROM leases l
      WHERE l.tenant_id = ? 
      AND l.end_date >= CURDATE()
      AND l.end_date <= DATE_ADD(CURDATE(), INTERVAL 90 DAY)
    `, [tenant_id]);

    const reminders = [
      ...rentReminders,
      ...maintenanceReminders,
      ...leaseReminders
    ].sort((a, b) => new Date(a.due_date) - new Date(b.due_date));

    res.json({ reminders });
  } catch (error) {
    console.error('Error fetching reminders:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get tenant's settings
router.get("/settings/:id", async (req, res) => {
  try {
    const tenant_id = parseInt(req.params.id);
    
    // Validate tenant_id
    if (isNaN(tenant_id)) {
      return res.status(400).json({ error: 'Invalid tenant ID' });
    }
    
    // Get user preferences
    const [userData] = await executeWithRetry(`
      SELECT 
        u.email,
        u.phone,
        u.first_name,
        u.last_name,
        u.profile_picture_url
      FROM users u
      WHERE u.user_id = ?
    `, [tenant_id]);

    // Get auto-pay settings
    const [autoPaySettings] = await executeWithRetry(`
      SELECT 
        aps.setting_id,
        aps.is_active,
        aps.auto_pay_date,
        aps.payment_method_id,
        tpm.payment_type,
        tpm.card_last4,
        tpm.bank_name,
        tpm.account_number,
        tpm.upi_id
      FROM auto_pay_settings aps
      LEFT JOIN tenant_payment_methods tpm ON aps.payment_method_id = tpm.method_id
      WHERE aps.tenant_id = ?
    `, [tenant_id]);

    // Get payment methods
    const [paymentMethods] = await executeWithRetry(`
      SELECT 
        method_id,
        payment_type,
        card_last4,
        bank_name,
        account_number,
        upi_id,
        is_default,
        is_active
      FROM tenant_payment_methods
      WHERE tenant_id = ?
      ORDER BY is_default DESC, created_at DESC
    `, [tenant_id]);

    const settings = {
      profile: userData[0] || {},
      autoPay: autoPaySettings[0] || null,
      paymentMethods: paymentMethods,
      preferences: {
        notifications: {
          email: true,
          sms: false,
          push: true,
          maintenance: true,
          rent: true,
          lease: true
        },
        privacy: {
          profileVisible: true,
          contactVisible: true,
          locationVisible: false
        },
        preferences: {
          language: 'en',
          theme: 'light',
          timezone: 'Asia/Kolkata'
        }
      }
    };

    res.json({ settings });
  } catch (error) {
    console.error('Error fetching settings:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update tenant's settings
router.put("/settings/:id", async (req, res) => {
  try {
    const tenant_id = parseInt(req.params.id);
    const { profile, autoPay, preferences } = req.body;
    
    // Validate tenant_id
    if (isNaN(tenant_id)) {
      return res.status(400).json({ error: 'Invalid tenant ID' });
    }
    
    // Update profile if provided
    if (profile) {
      await executeWithRetry(`
        UPDATE users 
        SET 
          email = ?,
          phone = ?,
          first_name = ?,
          last_name = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ?
      `, [profile.email, profile.phone, profile.first_name, profile.last_name, tenant_id]);
    }

    // Update auto-pay settings if provided
    if (autoPay) {
      if (autoPay.setting_id) {
        await executeWithRetry(`
          UPDATE auto_pay_settings 
          SET 
            is_active = ?,
            auto_pay_date = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE setting_id = ?
        `, [autoPay.is_active, autoPay.auto_pay_date, autoPay.setting_id]);
      } else {
        // Create new auto-pay setting
        await executeWithRetry(`
          INSERT INTO auto_pay_settings 
          (tenant_id, lease_id, payment_method_id, is_active, auto_pay_date)
          VALUES (?, ?, ?, ?, ?)
        `, [tenant_id, autoPay.lease_id, autoPay.payment_method_id, autoPay.is_active, autoPay.auto_pay_date]);
      }
    }

    res.json({ 
      success: true, 
      message: 'Settings updated successfully' 
    });
  } catch (error) {
    console.error('Error updating settings:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get tenant's rent schedules
router.get("/rent-schedules/:id", async (req, res) => {
  try {
    const tenant_id = parseInt(req.params.id);
    
    // Validate tenant_id
    if (isNaN(tenant_id)) {
      return res.status(400).json({ error: 'Invalid tenant ID' });
    }
    
    const [schedules] = await executeWithRetry(`
      SELECT 
        rs.*,
        l.rent_amount,
        p.title as property_title
      FROM rent_schedules rs
      JOIN leases l ON rs.lease_id = l.lease_id
      JOIN property p ON l.property_id = p.property_id
      WHERE l.tenant_id = ?
      ORDER BY rs.due_date DESC
    `, [tenant_id]);

    res.json({ schedules: schedules || [] });
  } catch (error) {
    console.error('Error fetching rent schedules:', error);
    res.status(500).json({ error: error.message });
  }
});

// Mark notification as read
router.put("/notifications/:id/:notificationId/read", async (req, res) => {
  try {
    const { id: tenant_id, notificationId } = req.params;
    
    // Mark notification as read logic here
    res.json({ 
      success: true, 
      message: 'Notification marked as read' 
    });
  } catch (error) {
    console.error('Error marking notification as read:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get tenant's dashboard analytics
router.get("/dashboard/analytics/:id", async (req, res) => {
  try {
    const tenant_id = req.params.id;
    
    // Get rent payment summary
    const [rentSummary] = await executeWithRetry(`
      SELECT 
        COUNT(*) as total_payments,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_payments,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending_payments,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_payments,
        SUM(amount) as total_amount_paid,
        AVG(amount) as average_payment
      FROM payments
      WHERE tenant_id = ? AND payment_type = 'rent'
      AND payment_date >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)
    `, [tenant_id]);

    // Get maintenance summary
    const [maintenanceSummary] = await executeWithRetry(`
      SELECT 
        COUNT(*) as total_requests,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_requests,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending_requests,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress_requests,
        AVG(CASE WHEN quote_amount IS NOT NULL THEN quote_amount ELSE 0 END) as average_quote
      FROM maintenance_requests
      WHERE tenant_id = ?
      AND created_at >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)
    `, [tenant_id]);

    // Get upcoming payments
    const [upcomingPayments] = await executeWithRetry(`
      SELECT 
        rs.due_date,
        rs.amount,
        rs.late_fee_amount,
        rs.total_due,
        p.title as property_title
      FROM rent_schedules rs
      JOIN leases l ON rs.lease_id = l.lease_id
      JOIN property p ON l.property_id = p.property_id
      WHERE l.tenant_id = ? 
      AND rs.status = 'pending'
      AND rs.due_date >= CURDATE()
      ORDER BY rs.due_date ASC
      LIMIT 3
    `, [tenant_id]);

    // Get recent activity
    const [recentActivity] = await executeWithRetry(`
      (SELECT 
        'payment' as type,
        'Rent Payment' as title,
        CONCAT('₹', FORMAT(amount, 0), ' paid') as description,
        created_at as timestamp,
        status
      FROM payments
      WHERE tenant_id = ? AND payment_type = 'rent'
      ORDER BY created_at DESC
      LIMIT 5)
      UNION ALL
      (SELECT 
        'maintenance' as type,
        'Maintenance Request' as title,
        CONCAT('Request #', request_id, ' - ', status) as description,
        updated_at as timestamp,
        status
      FROM maintenance_requests
      WHERE tenant_id = ?
      ORDER BY updated_at DESC
      LIMIT 5)
      ORDER BY timestamp DESC
      LIMIT 10
    `, [tenant_id, tenant_id]);

    const analytics = {
      rent: rentSummary[0] || {},
      maintenance: maintenanceSummary[0] || {},
      upcomingPayments,
      recentActivity
    };

    res.json({ analytics });
  } catch (error) {
    console.error('Error fetching dashboard analytics:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get tenant's rent status
router.get("/rent-status/:id", async (req, res) => {
  try {
    const tenant_id = parseInt(req.params.id);
    
    // Validate tenant_id
    if (isNaN(tenant_id)) {
      return res.status(400).json({ error: 'Invalid tenant ID' });
    }
    
    // Get current rent status
    const [rentStatus] = await executeWithRetry(`
      SELECT 
        l.lease_id,
        l.rent_amount,
        l.due_date,
        l.late_fee,
        l.late_fee_percentage,
        l.grace_period_days,
        p.title as property_title,
        p.address,
        rs.schedule_id,
        rs.month_year,
        rs.status as payment_status,
        rs.due_date as schedule_due_date,
        rs.amount as schedule_amount,
        rs.late_fee_amount,
        rs.total_due
      FROM leases l
      LEFT JOIN property p ON l.property_id = p.property_id
      LEFT JOIN rent_schedules rs ON l.lease_id = rs.lease_id
      WHERE l.tenant_id = ? 
      AND l.end_date >= CURDATE()
      AND (rs.month_year = DATE_FORMAT(CURDATE(), '%Y-%m') OR rs.month_year IS NULL)
      ORDER BY l.start_date DESC
      LIMIT 1
    `, [tenant_id]);

    if (rentStatus.length === 0) {
      return res.json({ 
        message: 'No active lease found',
        rentStatus: null 
      });
    }

    const status = rentStatus[0];
    const today = new Date();
    const dueDate = new Date(status.schedule_due_date || status.due_date);
    const daysUntilDue = Math.ceil((dueDate - today) / (1000 * 60 * 60 * 24));
    
    let rentStatusInfo = {
      lease_id: status.lease_id,
      property_title: status.property_title,
      property_address: status.address,
      rent_amount: status.rent_amount,
      due_date: status.schedule_due_date || status.due_date,
      days_until_due: daysUntilDue,
      payment_status: status.payment_status || 'pending',
      late_fee: status.late_fee,
      late_fee_percentage: status.late_fee_percentage,
      grace_period_days: status.grace_period_days,
      is_overdue: daysUntilDue < 0,
      is_due_soon: daysUntilDue <= 7 && daysUntilDue >= 0,
      total_due: status.total_due || status.rent_amount
    };

    res.json({ rentStatus: rentStatusInfo });
  } catch (error) {
    console.error('Error fetching rent status:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get tenant's auto-pay settings
router.get("/auto-pay/:id", async (req, res) => {
  try {
    const tenant_id = req.params.id;
    
    const [autoPaySettings] = await executeWithRetry(`
      SELECT 
        aps.setting_id,
        aps.lease_id,
        aps.payment_method_id,
        aps.is_active,
        aps.auto_pay_date,
        aps.created_at,
        aps.updated_at,
        tpm.payment_type,
        tpm.card_last4,
        tpm.bank_name,
        tpm.account_number,
        tpm.upi_id,
        l.rent_amount,
        p.title as property_title
      FROM auto_pay_settings aps
      LEFT JOIN tenant_payment_methods tpm ON aps.payment_method_id = tpm.method_id
      LEFT JOIN leases l ON aps.lease_id = l.lease_id
      LEFT JOIN property p ON l.property_id = p.property_id
      WHERE aps.tenant_id = ?
      ORDER BY aps.created_at DESC
    `, [tenant_id]);

    res.json({ autoPaySettings: autoPaySettings || [] });
  } catch (error) {
    console.error('Error fetching auto-pay settings:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update tenant's auto-pay settings
router.put("/auto-pay/:id", async (req, res) => {
  try {
    const tenant_id = req.params.id;
    const { lease_id, payment_method_id, is_active, auto_pay_date } = req.body;
    
    // Check if setting already exists
    const [existingSettings] = await executeWithRetry(`
      SELECT setting_id FROM auto_pay_settings 
      WHERE tenant_id = ? AND lease_id = ?
    `, [tenant_id, lease_id]);

    if (existingSettings.length > 0) {
      // Update existing setting
      await executeWithRetry(`
        UPDATE auto_pay_settings 
        SET 
          payment_method_id = ?,
          is_active = ?,
          auto_pay_date = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE tenant_id = ? AND lease_id = ?
      `, [payment_method_id, is_active, auto_pay_date, tenant_id, lease_id]);
    } else {
      // Create new auto-pay setting
      await executeWithRetry(`
        INSERT INTO auto_pay_settings 
        (tenant_id, lease_id, payment_method_id, is_active, auto_pay_date)
        VALUES (?, ?, ?, ?, ?)
      `, [tenant_id, lease_id, payment_method_id, is_active, auto_pay_date]);
    }

    res.json({ 
      success: true, 
      message: 'Auto-pay settings updated successfully' 
    });
  } catch (error) {
    console.error('Error updating auto-pay settings:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get tenant's payment history (enhanced version)
router.get("/payment-history/:id", async (req, res) => {
  try {
    const tenant_id = parseInt(req.params.id);
    const limit = parseInt(req.query.limit) || 20;
    const page = parseInt(req.query.page) || 1;
    const offset = (page - 1) * limit;
    
    // Validate tenant_id
    if (isNaN(tenant_id)) {
      return res.status(400).json({ error: 'Invalid tenant ID' });
    }
    
    // Get total count
    const [totalCount] = await executeWithRetry(`
      SELECT COUNT(*) as total
      FROM payments
      WHERE tenant_id = ? AND payment_type = 'rent'
    `, [tenant_id]);

    // Get payments with pagination
    const [payments] = await executeWithRetry(`
      SELECT 
        payment_id,
        amount,
        late_fee_amount,
        total_amount,
        payment_date,
        due_date,
        payment_method,
        transaction_id,
        status,
        remarks,
        created_at,
        updated_at
      FROM payments
      WHERE tenant_id = ? AND payment_type = 'rent'
      ORDER BY payment_date DESC
      LIMIT ? OFFSET ?
    `, [tenant_id, limit, offset]);

    // Get payment statistics
    const [stats] = await executeWithRetry(`
      SELECT 
        COUNT(*) as total_payments,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_payments,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending_payments,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_payments,
        SUM(amount) as total_amount,
        AVG(amount) as average_amount,
        SUM(late_fee_amount) as total_late_fees
      FROM payments
      WHERE tenant_id = ? AND payment_type = 'rent'
    `, [tenant_id]);

    res.json({ 
      payments: payments || [],
      pagination: {
        total: totalCount[0]?.total || 0,
        page,
        limit,
        totalPages: Math.ceil((totalCount[0]?.total || 0) / limit)
      },
      statistics: stats[0] || {}
    });
  } catch (error) {
    console.error('Error fetching payment history:', error);
    res.status(500).json({ error: error.message });
  }
});

// Process rent payment
router.post("/rent-payment", async (req, res) => {
  try {
    const { tenant_id, lease_id, amount, payment_method, schedule_id, remarks, payment_intent_id } = req.body;
    
    // Validate required fields
    if (!tenant_id || !lease_id || !amount) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Check if lease exists and is active
    const [leaseCheck] = await executeWithRetry(`
      SELECT l.*, p.title as property_title
      FROM leases l
      JOIN property p ON l.property_id = p.property_id
      WHERE l.lease_id = ? AND l.tenant_id = ?
    `, [lease_id, tenant_id]);

    if (leaseCheck.length === 0) {
      return res.status(404).json({ error: 'Lease not found' });
    }

    const lease = leaseCheck[0];

    // Generate transaction ID
    const transactionId = `TXN_${Date.now()}_${tenant_id}`;

    // Create payment record
    const [paymentResult] = await executeWithRetry(`
      INSERT INTO payments (
        lease_id, 
        tenant_id, 
        amount, 
        payment_method, 
        transaction_id, 
        remarks, 
        payment_type, 
        status, 
        payment_date
      ) VALUES (?, ?, ?, ?, ?, ?, 'rent', 'completed', CURDATE())
    `, [lease_id, tenant_id, amount, payment_method, transactionId, remarks]);

    const paymentId = paymentResult.insertId;

    // Update rent schedule if schedule_id is provided
    if (schedule_id) {
      await executeWithRetry(`
        UPDATE rent_schedules 
        SET status = 'paid', payment_id = ?
        WHERE schedule_id = ?
      `, [paymentId, schedule_id]);
    }

    // Create rent schedule for current month if it doesn't exist
    const currentMonth = new Date().toISOString().slice(0, 7);
    const [existingSchedule] = await executeWithRetry(`
      SELECT schedule_id FROM rent_schedules 
      WHERE lease_id = ? AND month_year = ?
    `, [lease_id, currentMonth]);

    if (existingSchedule.length === 0) {
      await executeWithRetry(`
        INSERT INTO rent_schedules (
          lease_id, 
          month_year, 
          due_date, 
          amount, 
          status, 
          payment_id
        ) VALUES (?, ?, CURDATE(), ?, 'paid', ?)
      `, [lease_id, currentMonth, amount, paymentId]);
    }

    res.json({ 
      success: true,
      message: 'Rent payment processed successfully',
      payment_id: paymentId,
      transaction_id: transactionId,
      amount: amount,
      payment_date: new Date().toISOString().split('T')[0]
    });

  } catch (error) {
    console.error('Error processing rent payment:', error);
    res.status(500).json({ error: error.message });
  }
});

export { router as TenantPortalRouter };

