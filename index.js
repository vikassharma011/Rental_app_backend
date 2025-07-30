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
import session from "express-session";
import { db } from "./db.js";
import dotenv from "dotenv";
import { TenantRouter } from "./Routes/Investor/Tenant.js";

dotenv.config();

const app = express();

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
app.use("/tenant" , TenantRouter) ; 

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
app.listen(port , () => {
  console.log(`Server is running on port ${port}`);
});
