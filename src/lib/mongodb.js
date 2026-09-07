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
      // Tuned for serverless, where many short-lived instances each open their
      // own pool rather than one process holding a large shared one.
      //
      // A default pool of 100 per instance multiplies across concurrent Vercel
      // functions and can exhaust the server's connection limit; a page load
      // fires eleven parallel requests, so this happens sooner than expected.
      maxPoolSize: 10,
      minPoolSize: 0,
      // The default is 30s, which on a 60s function leaves nothing for the work
      // itself — failing fast is more useful than timing out with no error.
      serverSelectionTimeoutMS: 10000,
      // Idle sockets are closed rather than held open by an instance that may
      // never be reused.
      maxIdleTimeMS: 60000,
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