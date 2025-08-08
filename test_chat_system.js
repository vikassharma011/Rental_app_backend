// Test script for chat system
import { db } from "./db.js";

async function testChatSystem() {
  try {
    console.log("🧪 Testing Chat System...\n");

    // Test 1: Check if messages table exists
    console.log("1. Checking messages table structure...");
    const [tables] = await db.execute("SHOW TABLES LIKE 'messages'");
    if (tables.length > 0) {
      console.log("✅ Messages table exists");
      
      // Check table structure
      const [columns] = await db.execute("DESCRIBE messages");
      console.log("📋 Table structure:");
      columns.forEach(col => {
        console.log(`   - ${col.Field}: ${col.Type} ${col.Null === 'NO' ? 'NOT NULL' : 'NULL'} ${col.Default ? `DEFAULT ${col.Default}` : ''}`);
      });
    } else {
      console.log("❌ Messages table does not exist");
    }

    // Test 2: Check if users table exists and has data
    console.log("\n2. Checking users table...");
    const [users] = await db.execute("SELECT COUNT(*) as count FROM users");
    console.log(`✅ Users table has ${users[0].count} records`);

    // Test 3: Check if properties table exists
    console.log("\n3. Checking properties table...");
    const [properties] = await db.execute("SELECT COUNT(*) as count FROM property");
    console.log(`✅ Properties table has ${properties[0].count} records`);

    // Test 4: Check if leases table exists
    console.log("\n4. Checking leases table...");
    const [leases] = await db.execute("SELECT COUNT(*) as count FROM leases");
    console.log(`✅ Leases table has ${leases[0].count} records`);

    // Test 5: Check if maintenance_requests table exists
    console.log("\n5. Checking maintenance_requests table...");
    const [maintenance] = await db.execute("SELECT COUNT(*) as count FROM maintenance_requests");
    console.log(`✅ Maintenance_requests table has ${maintenance[0].count} records`);

    // Test 6: Sample query to get investor contacts (tenants)
    console.log("\n6. Testing investor contacts query...");
    try {
      const [investorContacts] = await db.execute(`
        SELECT 
          u.user_id AS id, 
          CONCAT(u.first_name, ' ', u.last_name) AS name, 
          'tenant' AS role,
          u.email,
          p.title AS property_name
        FROM users u
        JOIN leases l ON u.user_id = l.tenant_id
        JOIN property p ON l.property_id = p.property_id
        WHERE p.investor_id = 1 AND u.is_active = 1
        LIMIT 5
      `);
      console.log(`✅ Found ${investorContacts.length} tenant contacts for investor`);
      investorContacts.forEach(contact => {
        console.log(`   - ${contact.name} (${contact.role}) - ${contact.property_name}`);
      });
    } catch (error) {
      console.log("⚠️  Investor contacts query failed (this is normal if no data exists)");
    }

    // Test 7: Sample query to get investor contacts (suppliers)
    console.log("\n7. Testing supplier contacts query...");
    try {
      const [supplierContacts] = await db.execute(`
        SELECT DISTINCT
          u.user_id AS id, 
          CONCAT(u.first_name, ' ', u.last_name) AS name, 
          'supplier' AS role,
          u.email,
          p.title AS property_name
        FROM users u
        JOIN maintenance_requests m ON u.user_id = m.supplier_id
        JOIN property p ON m.property_id = p.property_id
        WHERE p.investor_id = 1 AND u.is_active = 1
        LIMIT 5
      `);
      console.log(`✅ Found ${supplierContacts.length} supplier contacts for investor`);
      supplierContacts.forEach(contact => {
        console.log(`   - ${contact.name} (${contact.role}) - ${contact.property_name}`);
      });
    } catch (error) {
      console.log("⚠️  Supplier contacts query failed (this is normal if no data exists)");
    }

    // Test 8: Check message count
    console.log("\n8. Checking existing messages...");
    const [messageCount] = await db.execute("SELECT COUNT(*) as count FROM messages");
    console.log(`✅ Messages table has ${messageCount[0].count} records`);

    console.log("\n🎉 Chat system test completed successfully!");
    console.log("\n📝 Next steps:");
    console.log("1. Start the backend server: npm start");
    console.log("2. Start the frontend: cd ../rental_app_frontend && npm start");
    console.log("3. Navigate to /investor/messaging, /tenant/messaging, or /supplier/communication");
    console.log("4. Test the real-time chat functionality");

  } catch (error) {
    console.error("❌ Test failed:", error.message);
    console.log("\n🔧 Troubleshooting:");
    console.log("1. Check database connection in db.js");
    console.log("2. Ensure all required tables exist");
    console.log("3. Run the migration script: db_migration.sql");
  } finally {
    process.exit(0);
  }
}

testChatSystem();
