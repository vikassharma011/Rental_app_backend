import express from "express";
import { db } from "../../db.js";
import { createPaymentIntent, confirmPayment, createCustomer, createPaymentMethod, attachPaymentMethodToCustomer } from "../../utils/stripe.js";
import jwt from "jsonwebtoken";
const router = express.Router();

// Set default JWT_SECRET for local development
const JWT_SECRET = process.env.JWT_SECRET;

// Helper function to safely execute SQL with fallback for missing columns
const safeExecute = async (sql, params = []) => {
  try {
    return await db.execute(sql, params);
  } catch (error) {
    // If column doesn't exist, try simplified query
    if (error.message.includes('Unknown column')) {
      console.warn('Column not found, using simplified query:', error.message);
      // Remove problematic columns from query
      const simplifiedSql = sql
        .replace(/,\s*late_fee_amount/g, '')
        .replace(/,\s*total_amount/g, '')
        .replace(/,\s*gateway_response/g, '')
        .replace(/,\s*total_due/g, '');
      
      // Remove corresponding parameters
      const simplifiedParams = params.filter((_, index) => {
        const paramIndex = sql.split(',').findIndex(col => 
          col.includes('late_fee_amount') || 
          col.includes('total_amount') || 
          col.includes('gateway_response') ||
          col.includes('total_due')
        );
        return index !== paramIndex;
      });
      
      return await db.execute(simplifiedSql, simplifiedParams);
    }
    throw error;
  }
};

// Authentication middleware
const authenticateUser = (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) {
      return res.status(401).json({ error: "No token provided" });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    console.error("Authentication error:", error);
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: "Invalid token" });
    } else if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: "Token expired" });
    }
    return res.status(401).json({ error: "Authentication failed" });
  }
};

// ==================== RENT PAYMENT SYSTEM ====================

// Get tenant's current rent status and due amounts
router.get("/tenant/rent-status/:tenant_id", authenticateUser, async (req, res) => {
  try {
    const tenant_id = req.params.tenant_id;
    
    // Get current lease and rent schedule
    const [[lease]] = await db.execute(`
      SELECT l.*, p.title as property_title, p.address 
      FROM leases l 
      JOIN property p ON l.property_id = p.property_id 
      WHERE l.tenant_id = ? AND l.end_date >= CURDATE()
      ORDER BY l.start_date DESC LIMIT 1
    `, [tenant_id]);

    if (!lease) {
      return res.status(404).json({ error: "No active lease found" });
    }

    // Get current month's rent schedule
    const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
    let [[rentSchedule]] = await db.execute(`
      SELECT * FROM rent_schedules 
      WHERE lease_id = ? AND month_year = ? AND status = 'pending'
      ORDER BY due_date ASC LIMIT 1
    `, [lease.lease_id, currentMonth]);

    // If no current month schedule, create one
    if (!rentSchedule) {
      const currentDate = new Date();
      const dueDate = new Date(currentDate.getFullYear(), currentDate.getMonth(), lease.due_date);
      
      await db.execute(`
        INSERT INTO rent_schedules (lease_id, month_year, due_date, amount, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'pending', NOW(), NOW())
      `, [lease.lease_id, currentMonth, dueDate.toISOString().slice(0, 10), lease.rent_amount]);

      // Fetch the newly created schedule
      [[rentSchedule]] = await db.execute(`
        SELECT * FROM rent_schedules 
        WHERE lease_id = ? AND month_year = ? AND status = 'pending'
        ORDER BY due_date ASC LIMIT 1
      `, [lease.lease_id, currentMonth]);
    }

    // Calculate late fees if overdue
    let lateFeeAmount = 0;
    let isOverdue = false;
    
    if (rentSchedule) {
      const dueDate = new Date(rentSchedule.due_date);
      const today = new Date();
      const gracePeriod = lease.grace_period_days || 5;
      
      if (today > dueDate) {
        const daysLate = Math.ceil((today - dueDate) / (1000 * 60 * 60 * 24));
        if (daysLate > gracePeriod) {
          isOverdue = true;
          const lateFeePercentage = lease.late_fee_percentage || 5.00;
          lateFeeAmount = (rentSchedule.amount * lateFeePercentage) / 100;
        }
      }
    }

    // Get payment history
    const [paymentHistory] = await db.execute(`
      SELECT p.*, rs.month_year 
      FROM payments p 
      LEFT JOIN rent_schedules rs ON p.payment_id = rs.payment_id
      WHERE p.tenant_id = ? AND p.payment_type = 'rent'
      ORDER BY p.payment_date DESC 
      LIMIT 10
    `, [tenant_id]);

    res.json({
      lease,
      currentRent: rentSchedule,
      lateFeeAmount,
      isOverdue,
      totalDue: rentSchedule ? rentSchedule.amount + lateFeeAmount : 0,
      paymentHistory
    });
  } catch (error) {
    console.error("Error getting rent status:", error);
    res.status(500).json({ error: error.message });
  }
});

// Process rent payment with Stripe integration
router.post("/tenant/pay-rent", authenticateUser, async (req, res) => {
  try {
    const { 
      tenant_id, 
      lease_id, 
      amount, 
      payment_method, 
      schedule_id,
      remarks,
      payment_intent_id,
      card_details
    } = req.body;

    if (!tenant_id || !lease_id || !amount) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Get lease details for late fee calculation
    const [[lease]] = await db.execute(`
      SELECT * FROM leases WHERE lease_id = ? AND tenant_id = ?
    `, [lease_id, tenant_id]);

    if (!lease) {
      return res.status(404).json({ error: "Lease not found" });
    }

    // Calculate late fees
    let lateFeeAmount = 0;
    if (schedule_id) {
      const [[schedule]] = await db.execute(`
        SELECT * FROM rent_schedules WHERE schedule_id = ?
      `, [schedule_id]);

      if (schedule && schedule.status === 'pending') {
        const dueDate = new Date(schedule.due_date);
        const today = new Date();
        const gracePeriod = lease.grace_period_days || 5;
        
        if (today > dueDate) {
          const daysLate = Math.ceil((today - dueDate) / (1000 * 60 * 60 * 24));
          if (daysLate > gracePeriod) {
            const lateFeePercentage = lease.late_fee_percentage || 5.00;
            lateFeeAmount = (schedule.amount * lateFeePercentage) / 100;
          }
        }
      }
    }

    const totalAmount = parseFloat(amount) + lateFeeAmount;

    // Process payment with Stripe
    let stripeResult;
    let transactionId;

    if (payment_intent_id) {
      // Confirm existing payment intent
      stripeResult = await confirmPayment(payment_intent_id);
      if (stripeResult.success) {
        transactionId = stripeResult.transactionId;
      } else {
        return res.status(400).json({ error: stripeResult.error });
      }
    } else if (card_details) {
      // Create new payment intent with card details
      const metadata = {
        tenant_id: tenant_id.toString(),
        lease_id: lease_id.toString(),
        schedule_id: schedule_id?.toString() || '',
        payment_type: 'rent'
      };

      stripeResult = await createPaymentIntent(totalAmount, 'inr', metadata);
      if (stripeResult.success) {
        transactionId = stripeResult.paymentIntentId;
      } else {
        return res.status(400).json({ error: stripeResult.error });
      }
    } else {
      // Manual payment (cash/cheque)
      transactionId = `TXN_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    // Insert payment record with error handling for missing columns
    let paymentResult;
    try {
      [paymentResult] = await db.execute(`
        INSERT INTO payments (
          lease_id, tenant_id, amount, payment_type, payment_method, 
          transaction_id, payment_date, due_date, remarks, status
        ) VALUES (?, ?, ?, 'rent', ?, ?, CURDATE(), ?, ?, 'completed')
      `, [lease_id, tenant_id, totalAmount, payment_method || 'card', transactionId, 
          new Date().toISOString().slice(0, 10), remarks]);
    } catch (dbError) {
      console.warn('Database error, trying simplified insert:', dbError.message);
      // Fallback to basic insert
      [paymentResult] = await db.execute(`
        INSERT INTO payments (
          lease_id, tenant_id, amount, payment_type, payment_method, 
          transaction_id, payment_date, remarks, status
        ) VALUES (?, ?, ?, 'rent', ?, ?, CURDATE(), ?, 'completed')
      `, [lease_id, tenant_id, totalAmount, payment_method || 'card', transactionId, remarks]);
    }

    const paymentId = paymentResult.insertId;

    // Update rent schedule if provided
    if (schedule_id) {
      await db.execute(`
        UPDATE rent_schedules 
        SET status = 'paid', payment_id = ?, late_fee_amount = ?
        WHERE schedule_id = ?
      `, [paymentId, lateFeeAmount, schedule_id]);
    }

    res.status(201).json({
      success: true,
      payment_id: paymentId,
      transaction_id: transactionId,
      total_amount: totalAmount,
      late_fee_amount: lateFeeAmount,
      client_secret: stripeResult?.clientSecret
    });
  } catch (error) {
    console.error("Error processing rent payment:", error);
    res.status(500).json({ error: error.message });
  }
});

// Create payment intent for Stripe
router.post("/tenant/create-payment-intent", authenticateUser, async (req, res) => {
  try {
    const { amount, currency = 'inr', metadata = {} } = req.body;

    if (!amount) {
      return res.status(400).json({ error: "Amount is required" });
    }

    const result = await createPaymentIntent(amount, currency, metadata);
    
    if (result.success) {
      res.json({
        success: true,
        client_secret: result.clientSecret,
        payment_intent_id: result.paymentIntentId
      });
    } else {
      res.status(400).json({ error: result.error });
    }
  } catch (error) {
    console.error("Error creating payment intent:", error);
    res.status(500).json({ error: error.message });
  }
});

// Test endpoint to check all payments (for debugging)
router.get("/debug/payments/:tenant_id", authenticateUser, async (req, res) => {
  try {
    const tenant_id = req.params.tenant_id;
    
    console.log('Debug: Checking all payments for tenant:', tenant_id);
    
    // Check all payments for this tenant
    const [allPayments] = await db.execute(`
      SELECT * FROM payments WHERE tenant_id = ?
    `, [tenant_id]);
    
    console.log('Debug: Found payments:', allPayments);
    
    // Check payments table structure
    const [tableInfo] = await db.execute(`
      DESCRIBE payments
    `);
    
    console.log('Debug: Payments table structure:', tableInfo);
    
    res.json({
      tenant_id,
      all_payments: allPayments,
      table_structure: tableInfo,
      total_payments: allPayments.length
    });
  } catch (error) {
    console.error("Debug error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Get rent payment history for tenant
router.get("/tenant/payment-history/:tenant_id", authenticateUser, async (req, res) => {
  try {
    const tenant_id = req.params.tenant_id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    console.log('Fetching payment history for tenant:', tenant_id);
    console.log('Page:', page, 'Limit:', limit, 'Offset:', offset);

    const [payments] = await db.execute(`
      SELECT 
        p.*,
        l.rent_amount,
        l.start_date as lease_start,
        l.end_date as lease_end
      FROM payments p 
      LEFT JOIN leases l ON p.lease_id = l.lease_id
      WHERE p.tenant_id = ? AND p.payment_type = 'rent'
      ORDER BY p.payment_date DESC 
      LIMIT ? OFFSET ?
    `, [tenant_id, limit, offset]);

    console.log('Found payments:', payments.length);

    const [[totalCount]] = await db.execute(`
      SELECT COUNT(*) as count FROM payments 
      WHERE tenant_id = ? AND payment_type = 'rent'
    `, [tenant_id]);

    console.log('Total count:', totalCount.count);

    res.json({
      payments,
      pagination: {
        current_page: page,
        total_pages: Math.ceil(totalCount.count / limit),
        total_records: totalCount.count,
        has_next: offset + payments.length < totalCount.count
      }
    });
  } catch (error) {
    console.error("Error getting payment history:", error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== INVESTOR RENT COLLECTION ====================

// Get all tenants with rent status for investor
router.get("/investor/tenants-rent-status", authenticateUser, async (req, res) => {
  try {
    const { investor_id } = req.query;
    
    const [tenants] = await db.execute(`
      SELECT 
        u.user_id, u.first_name, u.last_name, u.email, u.phone,
        l.lease_id, l.rent_amount, l.start_date, l.end_date, l.due_date,
        p.property_id, p.title as property_title, p.address,
        rs.schedule_id, rs.month_year, rs.due_date as rent_due_date, 
        rs.amount as rent_amount, rs.status as rent_status,
        rs.late_fee_amount, rs.total_due,
        CASE 
          WHEN rs.due_date < CURDATE() AND rs.status = 'pending' THEN 'overdue'
          WHEN rs.status = 'paid' THEN 'paid'
          ELSE 'pending'
        END as payment_status
      FROM users u
      JOIN leases l ON u.user_id = l.tenant_id
      JOIN property p ON l.property_id = p.property_id
      LEFT JOIN rent_schedules rs ON l.lease_id = rs.lease_id 
        AND rs.month_year = DATE_FORMAT(CURDATE(), '%Y-%m')
      WHERE u.role = 'tenant' AND u.status = 'approved' AND u.is_active = 1
      ${investor_id ? 'AND p.investor_id = ?' : ''}
      ORDER BY rs.due_date ASC, u.first_name ASC
    `, investor_id ? [investor_id] : []);

    res.json({ tenants });
  } catch (error) {
    console.error("Error getting tenants rent status:", error);
    res.status(500).json({ error: error.message });
  }
});

// Record rent collection by investor
router.post("/investor/collect-rent", authenticateUser, async (req, res) => {
  try {
    const { 
      tenant_id, 
      lease_id, 
      amount, 
      payment_method, 
      schedule_id,
      remarks 
    } = req.body;

    if (!tenant_id || !lease_id || !amount) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Calculate late fees
    let lateFeeAmount = 0;
    if (schedule_id) {
      const [[schedule]] = await db.execute(`
        SELECT rs.*, l.late_fee_percentage, l.grace_period_days
        FROM rent_schedules rs
        JOIN leases l ON rs.lease_id = l.lease_id
        WHERE rs.schedule_id = ?
      `, [schedule_id]);

      if (schedule && schedule.status === 'pending') {
        const dueDate = new Date(schedule.due_date);
        const today = new Date();
        const gracePeriod = schedule.grace_period_days || 5;
        
        if (today > dueDate) {
          const daysLate = Math.ceil((today - dueDate) / (1000 * 60 * 60 * 24));
          if (daysLate > gracePeriod) {
            const lateFeePercentage = schedule.late_fee_percentage || 5.00;
            lateFeeAmount = (schedule.amount * lateFeePercentage) / 100;
          }
        }
      }
    }

    const totalAmount = parseFloat(amount) + lateFeeAmount;
    const transactionId = `INV_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Insert payment record
    const [paymentResult] = await db.execute(`
      INSERT INTO payments (
        lease_id, tenant_id, amount, late_fee_amount, total_amount, 
        payment_type, payment_method, transaction_id, payment_date, 
        due_date, remarks, status
      ) VALUES (?, ?, ?, ?, ?, 'rent', ?, ?, CURDATE(), ?, ?, 'completed')
    `, [lease_id, tenant_id, amount, lateFeeAmount, totalAmount, 
        payment_method || 'cash', transactionId, new Date().toISOString().slice(0, 10), remarks]);

    const paymentId = paymentResult.insertId;

    // Update rent schedule
    if (schedule_id) {
      await db.execute(`
        UPDATE rent_schedules 
        SET status = 'paid', payment_id = ?, late_fee_amount = ?, total_due = ?
        WHERE schedule_id = ?
      `, [paymentId, lateFeeAmount, totalAmount, schedule_id]);
    }

    res.status(201).json({
      success: true,
      payment_id: paymentId,
      transaction_id: transactionId,
      total_amount: totalAmount,
      late_fee_amount: lateFeeAmount
    });
  } catch (error) {
    console.error("Error recording rent collection:", error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== SUPPLIER PAYMENT SYSTEM ====================

// Get supplier's completed tasks and pending payments
router.get("/supplier/pending-payments/:supplier_id", authenticateUser, async (req, res) => {
  try {
    const supplier_id = req.params.supplier_id;
    
    const [pendingPayments] = await db.execute(`
      SELECT 
        mr.request_id, mr.issue_description, mr.status as request_status,
        mq.quote_id, mq.amount as quote_amount, mq.status as quote_status,
        p.title as property_title, p.address,
        u.first_name as tenant_first_name, u.last_name as tenant_last_name,
        mr.created_at as request_date, mq.created_at as quote_date
      FROM maintenance_requests mr
      JOIN maintenance_quotes mq ON mr.request_id = mq.request_id
      JOIN property p ON mr.property_id = p.property_id
      JOIN users u ON mr.tenant_id = u.user_id
      WHERE mq.supplier_id = ? 
        AND mr.status = 'completed' 
        AND mq.status = 'accepted'
        AND mq.payment_status = 'pending'
      ORDER BY mr.updated_at DESC
    `, [supplier_id]);

    res.json({ pendingPayments });
  } catch (error) {
    console.error("Error getting supplier pending payments:", error);
    res.status(500).json({ error: error.message });
  }
});

// Process supplier payment (by investor)
router.post("/investor/pay-supplier", authenticateUser, async (req, res) => {
  try {
    const { 
      supplier_id, 
      maintenance_request_id, 
      quote_id, 
      amount, 
      payment_method,
      remarks 
    } = req.body;

    if (!supplier_id || !maintenance_request_id || !quote_id || !amount) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Verify the quote is accepted and payment is pending
    const [[quote]] = await db.execute(`
      SELECT mq.*, mr.status as request_status
      FROM maintenance_quotes mq
      JOIN maintenance_requests mr ON mq.request_id = mr.request_id
      WHERE mq.quote_id = ? AND mq.supplier_id = ? 
        AND mq.status = 'accepted' AND mq.payment_status = 'pending'
        AND mr.status = 'completed'
    `, [quote_id, supplier_id]);

    if (!quote) {
      return res.status(400).json({ error: "Invalid quote or request not completed" });
    }

    const transactionId = `SUP_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Insert supplier payment record
    const [supplierPaymentResult] = await db.execute(`
      INSERT INTO supplier_payments (
        supplier_id, maintenance_request_id, quote_id, amount,
        payment_method, transaction_id, payment_date, remarks, status
      ) VALUES (?, ?, ?, ?, ?, ?, CURDATE(), ?, 'completed')
    `, [supplier_id, maintenance_request_id, quote_id, amount, 
        payment_method || 'bank_transfer', transactionId, remarks]);

    const supplierPaymentId = supplierPaymentResult.insertId;

    // Update quote payment status
    await db.execute(`
      UPDATE maintenance_quotes 
      SET payment_status = 'paid', payment_id = ?
      WHERE quote_id = ?
    `, [supplierPaymentId, quote_id]);

    // Also insert into main payments table for consistency
    await db.execute(`
      INSERT INTO payments (
        supplier_id, amount, payment_type, payment_method, 
        transaction_id, payment_date, remarks, status
      ) VALUES (?, ?, 'supplier', ?, ?, CURDATE(), ?, 'completed')
    `, [supplier_id, amount, payment_method || 'bank_transfer', transactionId, remarks]);

    res.status(201).json({
      success: true,
      supplier_payment_id: supplierPaymentId,
      transaction_id: transactionId,
      amount: amount
    });
  } catch (error) {
    console.error("Error processing supplier payment:", error);
    res.status(500).json({ error: error.message });
  }
});

// Get supplier payment history
router.get("/supplier/payment-history/:supplier_id", authenticateUser, async (req, res) => {
  try {
    const supplier_id = req.params.supplier_id;
    const { page = 1, limit = 10 } = req.query;
    const offset = (page - 1) * limit;

    const [payments] = await db.execute(`
      SELECT 
        sp.*, mr.issue_description, p.title as property_title,
        u.first_name as tenant_first_name, u.last_name as tenant_last_name
      FROM supplier_payments sp
      JOIN maintenance_requests mr ON sp.maintenance_request_id = mr.request_id
      JOIN property p ON mr.property_id = p.property_id
      JOIN users u ON mr.tenant_id = u.user_id
      WHERE sp.supplier_id = ?
      ORDER BY sp.payment_date DESC 
      LIMIT ? OFFSET ?
    `, [supplier_id, parseInt(limit), offset]);

    const [[totalCount]] = await db.execute(`
      SELECT COUNT(*) as count FROM supplier_payments WHERE supplier_id = ?
    `, [supplier_id]);

    res.json({
      payments,
      pagination: {
        current_page: parseInt(page),
        total_pages: Math.ceil(totalCount.count / limit),
        total_records: totalCount.count,
        has_next: offset + payments.length < totalCount.count
      }
    });
  } catch (error) {
    console.error("Error getting supplier payment history:", error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== PAYMENT METHODS MANAGEMENT ====================

// Get tenant's payment methods
router.get("/tenant/payment-methods/:tenant_id", authenticateUser, async (req, res) => {
  try {
    const tenant_id = req.params.tenant_id;
    
    const [methods] = await db.execute(`
      SELECT * FROM tenant_payment_methods 
      WHERE tenant_id = ? AND is_active = 1
      ORDER BY is_default DESC, created_at DESC
    `, [tenant_id]);

    res.json({ methods });
  } catch (error) {
    console.error("Error getting payment methods:", error);
    res.status(500).json({ error: error.message });
  }
});

// Add new payment method
router.post("/tenant/payment-methods", authenticateUser, async (req, res) => {
  try {
    const { 
      tenant_id, 
      payment_type, 
      card_last4, 
      bank_name, 
      account_number, 
      upi_id,
      is_default 
    } = req.body;

    if (!tenant_id || !payment_type) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // If setting as default, unset other defaults
    if (is_default) {
      await db.execute(`
        UPDATE tenant_payment_methods 
        SET is_default = 0 
        WHERE tenant_id = ?
      `, [tenant_id]);
    }

    const [result] = await db.execute(`
      INSERT INTO tenant_payment_methods (
        tenant_id, payment_type, card_last4, bank_name, 
        account_number, upi_id, is_default
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [tenant_id, payment_type, card_last4, bank_name, account_number, upi_id, is_default || 0]);

    res.status(201).json({
      success: true,
      method_id: result.insertId
    });
  } catch (error) {
    console.error("Error adding payment method:", error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== AUTO-PAY SYSTEM ====================

// Setup auto-pay for tenant
router.post("/tenant/auto-pay", authenticateUser, async (req, res) => {
  try {
    const { tenant_id, lease_id, payment_method_id, auto_pay_date } = req.body;

    if (!tenant_id || !lease_id || !payment_method_id) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Check if auto-pay already exists
    const [existing] = await db.execute(`
      SELECT * FROM auto_pay_settings 
      WHERE tenant_id = ? AND lease_id = ?
    `, [tenant_id, lease_id]);

    if (existing.length > 0) {
      // Update existing
      await db.execute(`
        UPDATE auto_pay_settings 
        SET payment_method_id = ?, auto_pay_date = ?, updated_at = NOW()
        WHERE tenant_id = ? AND lease_id = ?
      `, [payment_method_id, auto_pay_date || 1, tenant_id, lease_id]);
    } else {
      // Create new
      await db.execute(`
        INSERT INTO auto_pay_settings (
          tenant_id, lease_id, payment_method_id, auto_pay_date
        ) VALUES (?, ?, ?, ?)
      `, [tenant_id, lease_id, payment_method_id, auto_pay_date || 1]);
    }

    res.json({ success: true });
  } catch (error) {
    console.error("Error setting up auto-pay:", error);
    res.status(500).json({ error: error.message });
  }
});

// Get auto-pay settings
router.get("/tenant/auto-pay/:tenant_id", authenticateUser, async (req, res) => {
  try {
    const tenant_id = req.params.tenant_id;
    
    const [settings] = await db.execute(`
      SELECT aps.*, tpm.payment_type, tpm.card_last4, tpm.bank_name, tpm.upi_id
      FROM auto_pay_settings aps
      JOIN tenant_payment_methods tpm ON aps.payment_method_id = tpm.method_id
      WHERE aps.tenant_id = ? AND aps.is_active = 1
    `, [tenant_id]);

    res.json({ settings });
  } catch (error) {
    console.error("Error getting auto-pay settings:", error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== REPORTS AND ANALYTICS ====================

// Get payment summary for investor
router.get("/investor/payment-summary", authenticateUser, async (req, res) => {
  try {
    const { investor_id, start_date, end_date } = req.query;
    
    const dateFilter = start_date && end_date 
      ? `AND p.payment_date BETWEEN ? AND ?` 
      : '';

    const [summary] = await db.execute(`
      SELECT 
        COUNT(*) as total_payments,
        SUM(CASE WHEN p.payment_type = 'rent' THEN p.total_amount ELSE 0 END) as total_rent_collected,
        SUM(CASE WHEN p.payment_type = 'supplier' THEN p.amount ELSE 0 END) as total_supplier_payments,
        SUM(p.late_fee_amount) as total_late_fees,
        AVG(CASE WHEN p.payment_type = 'rent' THEN p.total_amount ELSE NULL END) as avg_rent_amount
      FROM payments p
      LEFT JOIN leases l ON p.lease_id = l.lease_id
      LEFT JOIN property prop ON l.property_id = prop.property_id
      WHERE p.status = 'completed' ${dateFilter}
      ${investor_id ? 'AND prop.investor_id = ?' : ''}
    `, start_date && end_date ? [start_date, end_date, ...(investor_id ? [investor_id] : [])] : (investor_id ? [investor_id] : []));

    res.json({ summary: summary[0] });
  } catch (error) {
    console.error("Error getting payment summary:", error);
    res.status(500).json({ error: error.message });
  }
});

export { router as EnhancedPaymentsRouter };
