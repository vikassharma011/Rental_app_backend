
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

// Dev seeding endpoint to create test data for a tenant (protected by DEV_SEED_KEY env)
router.post("/dev/seed", async (req, res) => {
  try {
    const devKey = req.headers["x-dev-seed-key"] || req.query.key;
    if ((process.env.DEV_SEED_KEY || 'allow-local') !== devKey) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const { tenant_id, property_id, rent_amount = 8000, due_day = 5 } = req.body;
    if (!tenant_id || !property_id) {
      return res.status(400).json({ error: "tenant_id and property_id are required" });
    }

    // 1) Ensure lease exists (active this month)
    const startDate = new Date();
    startDate.setDate(1);
    const endDate = new Date(startDate.getFullYear(), startDate.getMonth(), 28);
    const startStr = startDate.toISOString().slice(0,10);
    const endStr = endDate.toISOString().slice(0,10);

    await executeWithRetry(`
      INSERT INTO leases (tenant_id, property_id, start_date, end_date, rent_amount, due_date, late_fee, late_fee_percentage, grace_period_days, auto_late_fee, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, 5.00, 5, 1, NOW(), NOW())
    `, [tenant_id, property_id, rent_amount, startStr, endStr, due_day]);

    // Get latest lease
    const [[lease]] = await executeWithRetry(`
      SELECT * FROM leases WHERE tenant_id = ? ORDER BY start_date DESC LIMIT 1
    `, [tenant_id]);
    const lease_id = lease.lease_id;

    // 2) Create current month pending rent schedule if missing
    const currentMonth = new Date().toISOString().slice(0,7);
    await executeWithRetry(`
      INSERT INTO rent_schedules (lease_id, month_year, due_date, amount, late_fee_amount, total_due, status, created_at, updated_at)
      SELECT ?, ?, ?, ?, 0.00, ?, 'pending', NOW(), NOW()
      WHERE NOT EXISTS (
        SELECT 1 FROM rent_schedules WHERE lease_id = ? AND month_year = ?
      )
    `, [lease_id, currentMonth, `${currentMonth}-` + String(due_day).padStart(2,'0'), rent_amount, rent_amount, lease_id, currentMonth]);

    // 3) Ensure default card method
    await executeWithRetry(`
      INSERT INTO tenant_payment_methods (tenant_id, payment_type, card_last4, is_default, is_active, created_at, updated_at)
      VALUES (?, 'card', '4242', 1, 1, NOW(), NOW())
    `, [tenant_id]).catch(() => {});

    // Fetch method_id
    const [[method]] = await executeWithRetry(`
      SELECT method_id FROM tenant_payment_methods WHERE tenant_id = ? AND payment_type = 'card' ORDER BY is_default DESC, created_at DESC LIMIT 1
    `, [tenant_id]);

    // 4) Upsert auto-pay using that method
    const [existing] = await executeWithRetry(`
      SELECT setting_id FROM auto_pay_settings WHERE tenant_id = ? AND lease_id = ?
    `, [tenant_id, lease_id]);
    if (existing.length > 0) {
      await executeWithRetry(`
        UPDATE auto_pay_settings SET payment_method_id = ?, is_active = 1, auto_pay_date = ?, updated_at = NOW()
        WHERE tenant_id = ? AND lease_id = ?
      `, [method.method_id, due_day, tenant_id, lease_id]);
    } else {
      await executeWithRetry(`
        INSERT INTO auto_pay_settings (tenant_id, lease_id, payment_method_id, is_active, auto_pay_date, created_at, updated_at)
        VALUES (?, ?, ?, 1, ?, NOW(), NOW())
      `, [tenant_id, lease_id, method.method_id, due_day]);
    }

    res.json({ success: true, lease_id, payment_method_id: method.method_id });
  } catch (error) {
    console.error('Dev seed error:', error);
    res.status(500).json({ error: error.message });
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

// Upload maintenance photo
router.post("/maintenance/upload-photo/:tenantId", upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    const fileUrl = `/uploads/maintenance-photos/${req.file.filename}`;
    res.json({ success: true, file_url: fileUrl });
  } catch (error) {
    console.error('Photo upload error:', error);
    res.status(500).json({ error: error.message });
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

// Alias: contacts under messaging namespace for frontend compatibility
router.get('/messaging/contacts/:userId', authenticateTenant, async (req, res) => {
  try {
    const userId = req.params.userId;
    const search = req.query.search ? `%${req.query.search}%` : null;

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

// Dashboard analytics for tenant (basic stats)
router.get("/dashboard/analytics/:id", async (req, res) => {
  try {
    const tenant_id = parseInt(req.params.id);
    if (isNaN(tenant_id)) {
      return res.status(400).json({ error: 'Invalid tenant ID' });
    }

    const [[paymentsStats]] = await executeWithRetry(`
      SELECT 
        COUNT(*) as total_payments,
        SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed_payments,
        SUM(amount) as total_amount
      FROM payments WHERE tenant_id = ? AND payment_type='rent'
    `, [tenant_id]);

    const [[maintenanceStats]] = await executeWithRetry(`
      SELECT 
        SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) as open_requests,
        SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed_requests
      FROM maintenance_requests WHERE tenant_id = ?
    `, [tenant_id]);

    res.json({
      payments: paymentsStats || {},
      maintenance: maintenanceStats || {}
    });
  } catch (error) {
    console.error('Dashboard analytics error:', error);
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

// Leases list for tenant
router.get("/leases/:id", async (req, res) => {
  try {
    const tenant_id = parseInt(req.params.id);
    if (isNaN(tenant_id)) {
      return res.status(400).json({ error: 'Invalid tenant ID' });
    }
    const [leases] = await executeWithRetry(`
      SELECT l.*, p.title as property_title, p.address as property_address, p.city, p.state
      FROM leases l
      JOIN property p ON l.property_id = p.property_id
      WHERE l.tenant_id = ?
      ORDER BY l.start_date DESC
    `, [tenant_id]);
    res.json({ leases: leases || [] });
  } catch (error) {
    console.error('Error fetching leases:', error);
    res.status(500).json({ error: error.message });
  }
});

// Single lease by lease_id
router.get("/lease/:leaseId", async (req, res) => {
  try {
    const leaseId = parseInt(req.params.leaseId);
    if (isNaN(leaseId)) {
      return res.status(400).json({ error: 'Invalid lease ID' });
    }
    const [[lease]] = await executeWithRetry(`
      SELECT l.*, p.title as property_title, p.address as property_address, p.city, p.state
      FROM leases l
      JOIN property p ON l.property_id = p.property_id
      WHERE l.lease_id = ?
      LIMIT 1
    `, [leaseId]);
    res.json({ lease: lease || null });
  } catch (error) {
    console.error('Error fetching lease:', error);
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

// Get tenant's payment methods
router.get("/payment-methods/:id", async (req, res) => {
  try {
    const tenant_id = parseInt(req.params.id);
    
    // Validate tenant_id
    if (isNaN(tenant_id)) {
      return res.status(400).json({ error: 'Invalid tenant ID' });
    }
    
    const [paymentMethods] = await executeWithRetry(`
      SELECT 
        method_id,
        payment_type,
        card_last4,
        bank_name,
        account_number,
        upi_id,
        is_default,
        is_active,
        created_at
      FROM tenant_payment_methods
      WHERE tenant_id = ?
      ORDER BY is_default DESC, created_at DESC
    `, [tenant_id]);
    
    res.json({ paymentMethods: paymentMethods || [] });
  } catch (error) {
    console.error('Error fetching payment methods:', error);
    res.status(500).json({ error: error.message });
  }
});

// Add new payment method
router.post("/payment-methods/:id", async (req, res) => {
  try {
    const tenant_id = parseInt(req.params.id);
    const { payment_type, card_last4, bank_name, account_number, upi_id, is_default } = req.body;
    
    // Validate tenant_id
    if (isNaN(tenant_id)) {
      return res.status(400).json({ error: 'Invalid tenant ID' });
    }
    
    // If setting as default, unset other defaults first
    if (is_default) {
      await executeWithRetry(`
        UPDATE tenant_payment_methods 
        SET is_default = 0 
        WHERE tenant_id = ?
      `, [tenant_id]);
    }
    
    const [result] = await executeWithRetry(`
      INSERT INTO tenant_payment_methods 
      (tenant_id, payment_type, card_last4, bank_name, account_number, upi_id, is_default)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [tenant_id, payment_type, card_last4, bank_name, account_number, upi_id, is_default]);
    
    res.json({ 
      success: true, 
      message: 'Payment method added successfully',
      method_id: result.insertId
    });
  } catch (error) {
    console.error('Error adding payment method:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update payment method
router.put("/payment-methods/:id/:methodId", async (req, res) => {
  try {
    const tenant_id = parseInt(req.params.id);
    const { methodId } = req.params;
    const { payment_type, card_last4, bank_name, account_number, upi_id, is_default, is_active } = req.body;
    
    // Validate tenant_id
    if (isNaN(tenant_id)) {
      return res.status(400).json({ error: 'Invalid tenant ID' });
    }
    
    // If setting as default, unset other defaults first
    if (is_default) {
      await executeWithRetry(`
        UPDATE tenant_payment_methods 
        SET is_default = 0 
        WHERE tenant_id = ?
      `, [tenant_id]);
    }
    
    await executeWithRetry(`
      UPDATE tenant_payment_methods 
      SET 
        payment_type = ?,
        card_last4 = ?,
        bank_name = ?,
        account_number = ?,
        upi_id = ?,
        is_default = ?,
        is_active = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE method_id = ? AND tenant_id = ?
    `, [payment_type, card_last4, bank_name, account_number, upi_id, is_default, is_active, methodId, tenant_id]);
    
    res.json({ 
      success: true, 
      message: 'Payment method updated successfully' 
    });
  } catch (error) {
    console.error('Error updating payment method:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete payment method
router.delete("/payment-methods/:id/:methodId", async (req, res) => {
  try {
    const tenant_id = parseInt(req.params.id);
    const { methodId } = req.params;
    
    // Validate tenant_id
    if (isNaN(tenant_id)) {
      return res.status(400).json({ error: 'Invalid tenant ID' });
    }
    
    await executeWithRetry(`
      DELETE FROM tenant_payment_methods 
      WHERE method_id = ? AND tenant_id = ?
    `, [methodId, tenant_id]);
    
    res.json({ 
      success: true, 
      message: 'Payment method deleted successfully' 
    });
  } catch (error) {
    console.error('Error deleting payment method:', error);
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
    
    // Get current rent status - prefer a PAID schedule for current month if multiple exist
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
        rs.total_due,
        rs.updated_at
      FROM leases l
      LEFT JOIN property p ON l.property_id = p.property_id
      LEFT JOIN rent_schedules rs ON l.lease_id = rs.lease_id
        AND rs.month_year = DATE_FORMAT(CURDATE(), '%Y-%m')
      WHERE l.tenant_id = ? 
        AND l.end_date >= CURDATE()
      ORDER BY 
        CASE 
          WHEN rs.status = 'paid' THEN 0
          WHEN rs.status IN ('pending','due') THEN 1
          WHEN rs.status = 'overdue' THEN 2
          ELSE 3
        END,
        rs.updated_at DESC,
        l.start_date DESC
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
      rent_amount: Number(status.rent_amount) || 0,
      due_date: status.schedule_due_date || status.due_date,
      days_until_due: daysUntilDue,
      payment_status: status.payment_status || 'pending',
      late_fee: Number(status.late_fee) || 0,
      late_fee_percentage: Number(status.late_fee_percentage) || 0,
      grace_period_days: status.grace_period_days,
      is_overdue: daysUntilDue < 0,
      is_due_soon: daysUntilDue <= 7 && daysUntilDue >= 0,
      total_due: Number(status.total_due ?? status.rent_amount) || 0
    };

    res.json({ rentStatus: rentStatusInfo });
  } catch (error) {
    console.error('Error fetching rent status:', error);
    res.status(500).json({ error: error.message });
  }
});

// Tenant reminders (placeholder: build from rent_schedules and messages)
router.get("/reminders/:id", async (req, res) => {
  try {
    const tenant_id = parseInt(req.params.id);
    if (isNaN(tenant_id)) {
      return res.status(400).json({ error: 'Invalid tenant ID' });
    }

    const [upcomingSchedules] = await executeWithRetry(`
      SELECT rs.due_date, rs.amount, p.title as property_title
      FROM rent_schedules rs
      JOIN leases l ON rs.lease_id = l.lease_id
      JOIN property p ON l.property_id = p.property_id
      WHERE l.tenant_id = ? AND rs.status IN ('pending','due') AND rs.due_date >= CURDATE()
      ORDER BY rs.due_date ASC
      LIMIT 5
    `, [tenant_id]);

    const [unreadMessages] = await executeWithRetry(`
      SELECT m.created_at, CONCAT(u.first_name, ' ', u.last_name) as from_name
      FROM messages m
      JOIN users u ON m.sender_id = u.user_id
      WHERE m.receiver_id = ? AND m.is_read = 0
      ORDER BY m.created_at DESC
      LIMIT 5
    `, [tenant_id]);

    const reminders = [
      ...upcomingSchedules.map(s => ({
        type: 'rent_due',
        title: `Rent due for ${s.property_title}`,
        date: s.due_date,
        amount: s.amount
      })),
      ...unreadMessages.map(m => ({
        type: 'message',
        title: `New message from ${m.from_name}`,
        date: m.created_at
      }))
    ];

    res.json({ reminders });
  } catch (error) {
    console.error('Error fetching reminders:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get tenant's auto-pay settings
router.get("/auto-pay/:id", async (req, res) => {
  try {
    const tenant_id = parseInt(req.params.id);
    
    // Validate tenant_id
    if (isNaN(tenant_id)) {
      return res.status(400).json({ error: 'Invalid tenant ID' });
    }
    
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
    const tenant_id = parseInt(req.params.id);
    const { lease_id, payment_method_id, is_active, auto_pay_date } = req.body;
    
    // Validate tenant_id
    if (isNaN(tenant_id)) {
      return res.status(400).json({ error: 'Invalid tenant ID' });
    }
    
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

// Unread count for messaging
router.get("/messaging/unread/:id", async (req, res) => {
  try {
    const tenant_id = parseInt(req.params.id);
    if (isNaN(tenant_id)) {
      return res.status(400).json({ error: 'Invalid tenant ID' });
    }
    const [[{ unread }]] = await executeWithRetry(
      `SELECT COUNT(*) as unread FROM messages WHERE receiver_id = ? AND is_read = 0`,
      [tenant_id]
    );
    res.json({ unread });
  } catch (error) {
    console.error('Error getting unread count:', error);
    res.status(500).json({ error: error.message });
  }
});

// Mark messages as read for tenant
router.post("/messaging/read/:id", async (req, res) => {
  try {
    const tenant_id = parseInt(req.params.id);
    if (isNaN(tenant_id)) {
      return res.status(400).json({ error: 'Invalid tenant ID' });
    }
    await executeWithRetry(
      `UPDATE messages SET is_read = 1, updated_at = CURRENT_TIMESTAMP WHERE receiver_id = ? AND is_read = 0`,
      [tenant_id]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Error marking messages as read:', error);
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

// Tenant inventory items (aligned to schema: inventory_items)
router.get("/inventory/:id", async (req, res) => {
  try {
    const tenant_id = parseInt(req.params.id);
    if (isNaN(tenant_id)) {
      return res.status(400).json({ error: 'Invalid tenant ID' });
    }

    // Determine property by latest lease
    const [[lease]] = await executeWithRetry(
      `SELECT property_id FROM leases WHERE tenant_id = ? ORDER BY start_date DESC LIMIT 1`,
      [tenant_id]
    );
    if (!lease) return res.json({ inventory: [] });

    const [items] = await executeWithRetry(
      `SELECT item_id, item_name, item_type, purchase_date, warranty_end_date, supplier_id, created_at, updated_at
       FROM inventory_items WHERE property_id = ? ORDER BY created_at DESC`,
      [lease.property_id]
    );
    res.json({ inventory: items || [] });
  } catch (error) {
    console.error('Error fetching tenant inventory:', error);
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
    let total = 0;
    try {
      const [totalCount] = await executeWithRetry(`
        SELECT COUNT(*) as total
        FROM payments
        WHERE tenant_id = ? AND payment_type = 'rent'
      `, [tenant_id]);
      total = totalCount[0]?.total || 0;
    } catch (countErr) {
      console.warn('Count query failed, defaulting total to 0:', countErr.message);
      total = 0;
    }

    // Get payments with pagination
    let payments = [];
    try {
      const [rows] = await executeWithRetry(`
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
      payments = rows || [];
    } catch (listErr) {
      console.warn('Payments query failed, returning empty list:', listErr.message);
      payments = [];
    }

    // Get payment statistics
    let statistics = {};
    try {
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
      statistics = stats[0] || {};
    } catch (statsErr) {
      console.warn('Stats query failed, returning empty stats:', statsErr.message);
      statistics = {};
    }

    res.json({ 
      payments: payments,
      pagination: {
        total: total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
      },
      statistics
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

