// Run with: node test-db.js
// Diagnoses MongoDB Atlas connectivity. Read-only: it only runs "ping" and
// opens TLS sockets. TLS certificate verification stays ON everywhere.
//
// It answers, in order:
//   1. Which Node / OpenSSL / driver versions are in use?
//   2. Does DNS (SRV) resolve, and do the Atlas nodes have IPv4 and/or IPv6?
//   3. Does a raw, fully-verified TLS handshake succeed to EVERY Atlas node?
//      (repeated, to catch "works sometimes" behaviour)
//   4. What public IP(s) is Atlas seeing from this machine?
//   5. Does Mongoose connect and survive several parallel connections?

import "dotenv/config";
import dns from "node:dns/promises";
import tls from "node:tls";
import mongoose from "mongoose";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const line = (t = "") => console.log(t);
const head = (t) => console.log(`\n=== ${t} ===`);
const findings = [];

// ---------- 1. Environment ----------
head("1. Environment");
console.log("Node:", process.version);
console.log("OpenSSL (bundled in Node):", process.versions.openssl);
console.log("Mongoose:", require("mongoose/package.json").version);
console.log("MongoDB driver:", require("mongodb/package.json").version);
for (const v of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"]) {
    if (process.env[v]) console.log(`!! env ${v} is set -> ${v.includes("PROXY") ? "(value hidden)" : process.env[v]}`);
}

const uri = process.env.MONGO_URI;
if (!uri) {
    console.error("\nMONGO_URI is not set. Create .env from .env.example first.");
    process.exit(1);
}

// Parse host list without printing credentials
const isSrv = uri.startsWith("mongodb+srv://");
const afterScheme = uri.replace(/^mongodb(\+srv)?:\/\//, "");
// Drop "user:password@" (never printed), keep "host(s)/db?options"
const hostAndRest = afterScheme.slice(afterScheme.lastIndexOf("@") + 1);
const hostPart = hostAndRest.split(/[/?]/)[0];
const dbName = hostAndRest.split("?")[0].split("/")[1] || "";
console.log("\nURI scheme:", isSrv ? "mongodb+srv (Atlas SRV)" : "mongodb");
console.log("Host(s):", hostPart);
console.log("Database name in URI:", dbName || "(none - defaults to 'test')");
if (/<|>/.test(uri)) {
    console.error("\nMONGO_URI still contains <placeholders>. Put your real values in .env.");
    process.exit(1);
}

// ---------- 2. DNS ----------
head("2. DNS");
let nodes = []; // [{host, port}]
try {
    if (isSrv) {
        const srv = await dns.resolveSrv(`_mongodb._tcp.${hostPart}`);
        nodes = srv.map((r) => ({ host: r.name, port: r.port }));
        console.log("SRV records:", nodes.map((n) => `${n.host}:${n.port}`).join(", "));
        try {
            const txt = await dns.resolveTxt(hostPart);
            console.log("TXT records:", txt.map((t) => t.join("")).join(" | "));
        } catch { console.log("TXT records: none"); }
    } else {
        nodes = hostPart.split(",").map((h) => {
            const [host, port] = h.split(":");
            return { host, port: Number(port) || 27017 };
        });
    }
} catch (e) {
    console.error("DNS SRV lookup FAILED:", e.code, e.message);
    findings.push("DNS SRV lookup failed -> network/DNS/proxy problem (not a TLS problem). Try another DNS (e.g. 8.8.8.8) or a non-SRV connection string from Atlas.");
}

for (const n of nodes) {
    const v4 = await dns.resolve4(n.host).catch(() => []);
    const v6 = await dns.resolve6(n.host).catch(() => []);
    console.log(`${n.host}  A=${v4.join(",") || "-"}  AAAA=${v6.join(",") || "-"}`);
    if (v6.length) findings.push(`${n.host} has IPv6 (AAAA) records: if your machine uses IPv6, the IP Atlas sees may differ from your IPv4 address (see section 4).`);
}

// ---------- 3. Raw TLS handshake (verification ON) ----------
head("3. Raw TLS handshake to each node (certificate verification ON)");
const useTls = isSrv || /[?&](tls|ssl)=true/i.test(uri);
const tlsResults = [];
function probe(host, port) {
    return new Promise((resolve) => {
        const sock = tls.connect(
            { host, port, servername: host, minVersion: "TLSv1.2", timeout: 10000 }, // rejectUnauthorized stays at its secure default (true)
            () => {
                const out = { ok: true, proto: sock.getProtocol(), cipher: sock.getCipher().name, authorized: sock.authorized };
                sock.end();
                resolve(out);
            }
        );
        sock.on("timeout", () => { sock.destroy(); resolve({ ok: false, code: "TIMEOUT", msg: "no response in 10s" }); });
        sock.on("error", (e) => resolve({ ok: false, code: e.code, msg: e.message }));
    });
}
if (!useTls) {
    console.log("Connection string is not using TLS (looks like a local MongoDB) - skipping.");
} else {
    const ATTEMPTS = 3;
    for (const n of nodes) {
        const r = [];
        for (let i = 0; i < ATTEMPTS; i++) r.push(await probe(n.host, n.port));
        const okCount = r.filter((x) => x.ok).length;
        tlsResults.push({ host: n.host, okCount, attempts: ATTEMPTS, results: r });
        console.log(`${n.host}: ${okCount}/${ATTEMPTS} handshakes OK`);
        const first = r.find((x) => x.ok);
        if (first) console.log(`   ${first.proto}, ${first.cipher}, cert verified: ${first.authorized}`);
        for (const bad of r.filter((x) => !x.ok).slice(0, 1)) console.log(`   failure: ${bad.code} - ${bad.msg}`);
    }
}

// ---------- 4. Public IP ----------
head("4. Public IP(s) as seen from the internet (via api.ipify.org)");
async function ip(url) {
    try {
        const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
        return (await r.text()).trim();
    } catch { return null; }
}
const ip4 = await ip("https://api.ipify.org");
const ip6 = await ip("https://api6.ipify.org");
console.log("IPv4:", ip4 ?? "(could not determine)");
console.log("IPv6:", ip6 ?? "(none / could not determine)");
console.log("-> Compare with Atlas > Security > Network Access > IP Access List.");

// ---------- 5. Mongoose + pool stress ----------
head("5. Mongoose connection + parallel pooled connections");
let mongooseOk = false;
try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
    console.log("Connected. Server version:", (await mongoose.connection.db.admin().serverInfo()).version);
    const settled = await Promise.allSettled(
        Array.from({ length: 10 }, () => mongoose.connection.db.admin().ping())
    );
    const failed = settled.filter((s) => s.status === "rejected");
    console.log(`10 parallel pings: ${10 - failed.length} OK, ${failed.length} failed`);
    if (failed[0]) console.log("   first failure:", failed[0].reason?.message);
    mongooseOk = failed.length === 0;
    if (failed.length) findings.push("Some pooled connections failed while others succeeded -> intermittent rejection (typical of a changing/rotating public IP, see section 4).");
} catch (e) {
    console.error("Mongoose connect FAILED:", e.name);
    console.error("  message:", e.message);
    console.error("  cause code:", e.cause?.code ?? e.reason?.servers?.values?.().next?.().value?.error?.cause?.code ?? "(n/a)");
    const text = `${e.message} ${e.cause?.code ?? ""}`;
    if (/tlsv1 alert internal error|ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR/i.test(text)) {
        findings.push("TLS alert 80 (internal_error) is sent BY THE ATLAS SERVER during the handshake.");
    }
} finally {
    await mongoose.disconnect().catch(() => {});
}

// ---------- Verdict ----------
head("Verdict");
const anyTlsFail = tlsResults.some((t) => t.okCount < t.attempts);
const allTlsFail = tlsResults.length > 0 && tlsResults.every((t) => t.okCount === 0);
const alert80 = tlsResults.some((t) => t.results.some((x) => x.code === "ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR"));

if (mongooseOk && !anyTlsFail) {
    console.log("ALL GOOD: DNS, TLS and Mongoose all work from this machine right now.");
} else if (alert80 || allTlsFail) {
    console.log("Atlas is rejecting the TLS handshake from this machine's IP.");
    console.log("Raw TLS probes use Node's own OpenSSL with verification ON; if they fail with alert 80, the");
    console.log("server (not your OpenSSL / Mongoose / driver version) is refusing the connection. Most likely causes, in order:");
    console.log("  1. This machine's public IP (section 4) is not in Atlas > Network Access.");
    console.log("  2. The cluster is paused/stopped (Atlas > Database: look for a 'Resume' button).");
    console.log("  3. Your public IP changes between connections (mobile hotspot, CGNAT, VPN, IPv4/IPv6 mix).");
} else if (anyTlsFail) {
    console.log("Intermittent failures: some handshakes succeed and some fail. Strongly suggests the");
    console.log("source IP Atlas sees is changing between connections (CGNAT / hotspot / VPN / IPv4+IPv6).");
}
for (const f of [...new Set(findings)]) console.log(" -", f);
line();
process.exit(mongooseOk ? 0 : 1);
