
import mongoose from "mongoose";

const connectDB = async () => {
    if (!process.env.MONGO_URI) {
        throw new Error(
            "MONGO_URI is not set. Create a .env file (copy .env.example) and add your Atlas connection string."
        );
    }

    // Surface connection problems that happen AFTER the first successful connect
    // (e.g. a later pooled connection failing its TLS handshake).
    mongoose.connection.on("error", (err) => {
        console.error("MongoDB connection error:", err.message);
    });
    mongoose.connection.on("disconnected", () => {
        console.warn("MongoDB disconnected");
    });

    try {
        await mongoose.connect(process.env.MONGO_URI, {
            // Fail with a clear error in 15s instead of the 30s default
            serverSelectionTimeoutMS: 15000
        });

        console.log("MongoDB connected successfully!");
    } catch (error) {
        console.error("MongoDB connection failed:", error.message);

        // Atlas sends TLS alert 80 when it rejects a client at the handshake.
        // The most common reason is that the client's public IP is not in the
        // Atlas Network Access list. Run `node test-db.js` for a full diagnosis.
        if (/tlsv1 alert internal error|ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR/i.test(
            `${error.message} ${error.cause?.code ?? ""} ${error.reason ?? ""}`
        )) {
            console.error(
                "Hint: Atlas rejected the TLS handshake. Check Atlas > Network Access " +
                "(is your CURRENT public IP listed?) and run: node test-db.js"
            );
        }

        throw error; // index.js prints it once and exits with code 1
    }
};

export default connectDB;
