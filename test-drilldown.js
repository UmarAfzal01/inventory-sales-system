import { MongoClient } from "mongodb";
import fs from "fs";
import path from "path";

// Manually read .env.local without needing the dotenv package
try {
  const envPath = path.resolve(process.cwd(), ".env.local");
  if (fs.existsSync(envPath)) {
    const envFile = fs.readFileSync(envPath, "utf8");
    envFile.split("\n").forEach((line) => {
      const parts = line.split("=");
      if (parts.length >= 2) {
        const key = parts[0].trim();
        const value = parts.slice(1).join("=").trim().replace(/^["']|["']$/g, "");
        if (key && !process.env[key]) {
          process.env[key] = value;
        }
      }
    });
  }
} catch (e) {
  console.log("Could not auto-read .env.local, checking process.env directly...");
}

const uri = process.env.MONGODB_URI;

if (!uri) {
  console.error("❌ MONGODB_URI is not defined! Make sure it is in your .env.local file.");
  process.exit(1);
}

// Extract database name from URI
const getDbName = (connectionString) => {
  try {
    const url = new URL(connectionString);
    const pathname = url.pathname.replace("/", "");
    return pathname ? pathname.split("?")[0] : "inventory_warehouse";
  } catch {
    return "inventory_warehouse";
  }
};

async function testDrillDown() {
  const client = new MongoClient(uri);
  try {
    console.log("Connecting to MongoDB...");
    await client.connect();
    
    const dbName = getDbName(uri);
    const db = client.db(dbName);
    console.log(`✅ Connected successfully to database: "${db.databaseName}"\n`);

    console.log("--- 1. Checking Products Sample ---");
    const sampleProduct = await db.collection("products").findOne({});
    console.log(JSON.stringify(sampleProduct, null, 2));

    console.log("\n--- 2. Checking Daily Cube Fields ---");
    const sampleDailyCube = await db.collection("daily_cube").findOne({});
    console.log(JSON.stringify(sampleDailyCube, null, 2));

    console.log("\n--- 3. Checking Stock Cube Fields ---");
    const sampleStockCube = await db.collection("stock_cube").findOne({});
    console.log(JSON.stringify(sampleStockCube, null, 2));

  } catch (err) {
    console.error("❌ Connection error:", err);
  } finally {
    await client.close();
  }
}

testDrillDown();