// src/index.ts
import express from "express";
import cors from "cors" ; 
// import passport from "passport";
import { googleAuthRoutes } from "./Routes/auth/google.js";
import {auth} from "./Routes/auth/Auth.js";
import passport from "./Routes/auth/passport.js"; // ✅ Passport import karo
// import { project } from "./projects/project";
import { db } from "./db.js";
import dotenv from "dotenv";

dotenv.config();

const app = express();

app.use(express.json());
app.use(
  cors({
    origin: "http://localhost:3000", // ✅ React frontend ka origin specify karo
    credentials: true, // ✅ Cookies aur authentication ke liye zaroori hai
    methods: "GET, POST, PUT, DELETE",
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(passport.initialize());
app.use(passport.session());

app.use("/auth", auth);
app.use("/auth", googleAuthRoutes);

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
