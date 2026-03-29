import { exec } from "child_process";
import { Pool } from "pg";
import pino from "pino";

const logger = pino({ level: "info" });
const DATABASE_URL = process.env.DATABASE_URL;
const CHECK_INTERVAL = 60 * 1000; // Check every 60 seconds
const SSL_EMAIL = process.env.SSL_EMAIL || "admin@snipr.sh";

if (!DATABASE_URL) { logger.error("DATABASE_URL required"); process.exit(1); }

const pool = new Pool({ connectionString: DATABASE_URL, max: 3 });

// Track which domains already have SSL
const sslInstalled = new Set<string>();

function runCommand(cmd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
  });
}

async function checkCertExists(domain: string): Promise<boolean> {
  try {
    await runCommand(`certbot certificates -d ${domain} 2>/dev/null | grep -q "Certificate Name"`);
    return true;
  } catch {
    return false;
  }
}

async function installSSL(domain: string): Promise<boolean> {
  try {
    logger.info({ domain }, "Installing SSL certificate...");
    await runCommand(
      `certbot --nginx -d ${domain} --non-interactive --agree-tos -m ${SSL_EMAIL} --redirect 2>&1`
    );
    logger.info({ domain }, "SSL installed successfully!");
    return true;
  } catch (err: any) {
    logger.error({ domain, error: err.message }, "SSL installation failed");
    return false;
  }
}

async function syncDomains(): Promise<void> {
  try {
    const { rows } = await pool.query<{ domain: string }>(
      `SELECT domain FROM domains WHERE verified = true ORDER BY created_at`
    );

    for (const row of rows) {
      const domain = row.domain;

      // Skip if already processed
      if (sslInstalled.has(domain)) continue;

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
  } catch (err) {
    logger.error({ err }, "Domain sync failed");
  }
}

// Run immediately, then on interval
logger.info("SSL Manager started - checking for new verified domains...");
syncDomains();
setInterval(syncDomains, CHECK_INTERVAL);
