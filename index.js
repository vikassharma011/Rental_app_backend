// src/index.ts
import express from "express";
import cors from "cors" ; 
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const passport = require('passport');
import { googleAuthRoutes } from "./Routes/auth/google.js";
import {auth} from "./Routes/auth/Auth.js";
import  "./Routes/auth/passport.js"; // ✅ Passport import karo
import { PropertyRouter } from "./Routes/Investor/Property.js";
import { MaintenanceRouter } from "./Routes/Investor/Maintenance.js";
import { SupplierRouter } from "./Routes/Investor/Supplier.js";
import { InventoryRouter } from "./Routes/Investor/Inventory.js";
import session from "express-session";
import { db } from "./db.js";
import dotenv from "dotenv";
import { TenantRouter } from "./Routes/Investor/Tenant.js";

import { PaymentsRouter } from "./Routes/Investor/Payments.js";
import { EnhancedPaymentsRouter } from "./Routes/Investor/EnhancedPayments.js";

import { DocumentsRouter } from "./Routes/Investor/Documents.js";

// Import common messaging router
import { MessagingRouter as CommonMessagingRouter } from "./Routes/Messaging.js";

dotenv.config();

import http from 'http';
import { Server as SocketIOServer } from 'socket.io';

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: "http://localhost:3000",
    credentials: true
  }
});

// Socket.IO connection
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join', ({ userId }) => {
    socket.join(`user_${userId}`);
  });

  socket.on('send_message', (data) => {
    // Broadcast to receiver
    io.to(`user_${data.receiver_id}`).emit('receive_message', data);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

app.use(cors({
  origin: "http://localhost:3000",
  credentials: true,
  methods: "GET, POST, PUT, DELETE, OPTIONS", 
  allowedHeaders: ["Content-Type", "Authorization"],
}));

app.use(express.json());

app.use(
  session({
    secret: "your-secret",
    resave: false,
    saveUninitialized: true,
  })
);

app.use(passport.initialize());
app.use(passport.session());

app.use("/auth", auth);
app.use("/auth", googleAuthRoutes);
app.use("/investor", PropertyRouter);
app.use("/investor", MaintenanceRouter);
app.use("/investor", SupplierRouter);
app.use("/investor", InventoryRouter);
app.use("/tenant" , TenantRouter) ; 

import { TenantPortalRouter } from "./Routes/Tenant/Portal.js";
app.use("/tenant/portal", TenantPortalRouter);

import { SupplierPortalRouter } from "./Routes/Supplier/Portal.js";
app.use("/supplier/portal", SupplierPortalRouter);

app.use("/investor/payments", PaymentsRouter);
app.use("/api/payments", EnhancedPaymentsRouter);

app.use("/investor/documents", DocumentsRouter);

// Add common messaging routes
app.use("/messaging", CommonMessagingRouter);

app.get("/", (req, res) => {
  res.send("Hello, Rental App!");
});


(async () => {
  try {
    const connection = await db.getConnection();
    console.log("✅ Database connected successfully!");
    connection.release();
  } catch (error) {
    console.error("❌ Database connection failed:", error);
    process.exit(1); // Stop the app if DB fails
  }
})();

const port = Number(process.env.PORT) || 5000 ;
server.listen(port , () => {
  console.log(`Server is running with Socket.IO on port ${port}`);
});
