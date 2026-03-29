"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const child_process_1 = require("child_process");
const pg_1 = require("pg");
const pino_1 = __importDefault(require("pino"));
const logger = (0, pino_1.default)({ level: "info" });
const DATABASE_URL = process.env.DATABASE_URL;
const CHECK_INTERVAL = 60 * 1000; // Check every 60 seconds
const SSL_EMAIL = process.env.SSL_EMAIL || "admin@snipr.sh";
if (!DATABASE_URL) {
    logger.error("DATABASE_URL required");
    process.exit(1);
}
const pool = new pg_1.Pool({ connectionString: DATABASE_URL, max: 3 });
// Track which domains already have SSL
const sslInstalled = new Set();
function runCommand(cmd) {
    return new Promise((resolve, reject) => {
        (0, child_process_1.exec)(cmd, { timeout: 120000 }, (err, stdout, stderr) => {
            if (err)
                reject(err);
            else
                resolve({ stdout, stderr });
        });
    });
}
async function checkCertExists(domain) {
    try {
        await runCommand(`certbot certificates -d ${domain} 2>/dev/null | grep -q "Certificate Name"`);
        return true;
    }
    catch {
        return false;
    }
}
async function installSSL(domain) {
    try {
        logger.info({ domain }, "Installing SSL certificate...");
        await runCommand(`certbot --nginx -d ${domain} --non-interactive --agree-tos -m ${SSL_EMAIL} --redirect 2>&1`);
        logger.info({ domain }, "SSL installed successfully!");
        return true;
    }
    catch (err) {
        logger.error({ domain, error: err.message }, "SSL installation failed");
        return false;
    }
}
async function syncDomains() {
    try {
        const { rows } = await pool.query(`SELECT domain FROM domains WHERE verified = true ORDER BY created_at`);
        for (const row of rows) {
            const domain = row.domain;
            // Skip if already processed
            if (sslInstalled.has(domain))
                continue;
            // Check if cert already exists
            const hasCert = await checkCertExists(domain);
            if (hasCert) {
                sslInstalled.add(domain);
                continue;
            }
            // Install SSL
            const success = await installSSL(domain);
            if (success) {
                sslInstalled.add(domain);
            }
        }
    }
    catch (err) {
        logger.error({ err }, "Domain sync failed");
    }
}
// Run immediately, then on interval
logger.info("SSL Manager started - checking for new verified domains...");
syncDomains();
setInterval(syncDomains, CHECK_INTERVAL);
