import mongoose from "mongoose";

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  throw new Error("Please define the MONGODB_URI environment variable inside .env.local");
}

let cached = global.mongoose;

if (!cached) {
  cached = global.mongoose = { conn: null, promise: null };
}

async function dbConnect() {
  if (cached.conn) {
    return cached.conn;
  }

  if (!cached.promise) {
    const opts = {
      bufferCommands: false,
    };

    cached.promise = mongoose.connect(MONGODB_URI, opts).then(async (mongoose) => {
      // `bufferCommands: false` stops Mongoose from queuing its automatic index
      // build, so on a brand-new database the schema's indexes — including the
      // unique one on `barcode` — are never created. Without it, concurrent
      // upserts can produce duplicate products. Building them explicitly is a
      // no-op where they already exist.
      await Promise.all(
        Object.values(mongoose.models).map((model) =>
          model.createIndexes().catch((err) => {
            console.error(`Index build failed for ${model.modelName}:`, err.message);
          })
        )
      );
      return mongoose;
    });
  }
  
  cached.conn = await cached.promise;
  return cached.conn;
}

export default dbConnect;