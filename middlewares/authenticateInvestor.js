import jwt from "jsonwebtoken";

// Set default JWT_SECRET for local development
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-for-development';

export const authenticateInvestor = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ success: false });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== "investor") {
      return res.status(403).json({ success: false, message: "Only investors can approve users" });
    }
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ success: false, message: "Invalid token" });
  }
};
