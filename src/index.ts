import express from "express";
import compression from "compression";
import { Pool } from "pg";
import pino from "pino";
import pinoHttp from "pino-http";

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

// ─── Config ──────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "8080", 10);
const DATABASE_URL = process.env.DATABASE_URL;
const SNIPR_URL = process.env.SNIPR_URL || "https://snipr.sh";

if (!DATABASE_URL) {
  logger.error("DATABASE_URL is required");
  process.exit(1);
}

// ─── Database ────────────────────────────────────────────
const pool = new Pool({ connectionString: DATABASE_URL, max: 20 });

interface DomainRecord {
  id: string;
  workspace_id: string;
  domain: string;
  verified: boolean;
  supports_subdomains: boolean;
}

interface LinkRecord {
  id: string;
  slug: string;
  destination_url: string;
  enabled: boolean;
  workspace_id: string;
  domain_id: string;
}

// ─── Domain Cache (5 min TTL) ────────────────────────────
const domainCache = new Map<string, { data: DomainRecord | null; ts: number }>();
const CACHE_TTL = 5 * 60 * 1000;

async function lookupDomain(host: string): Promise<DomainRecord | null> {
  const cached = domainCache.get(host);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  const { rows } = await pool.query<DomainRecord>(
    `SELECT id, workspace_id, domain, verified, supports_subdomains FROM domains WHERE domain = $1 AND verified = true LIMIT 1`,
    [host]
  );

  const record = rows[0] || null;
  domainCache.set(host, { data: record, ts: Date.now() });
  return record;
}

async function lookupParentDomain(parentDomain: string): Promise<DomainRecord | null> {
  const cached = domainCache.get(`parent:${parentDomain}`);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  const { rows } = await pool.query<DomainRecord>(
    `SELECT id, workspace_id, domain, verified, supports_subdomains FROM domains WHERE domain = $1 AND verified = true AND supports_subdomains = true LIMIT 1`,
    [parentDomain]
  );

  const record = rows[0] || null;
  domainCache.set(`parent:${parentDomain}`, { data: record, ts: Date.now() });
  return record;
}

async function lookupLink(slug: string, domainId: string): Promise<LinkRecord | null> {
  const { rows } = await pool.query<LinkRecord>(
    `SELECT id, slug, destination_url, enabled, workspace_id, domain_id FROM links WHERE slug = $1 AND domain_id = $2 LIMIT 1`,
    [slug, domainId]
  );
  return rows[0] || null;
}

// ─── Comprehensive Bot / Prefetch Filter ─────────────────
// 200+ known bots, crawlers, scrapers, AI agents, SEO tools, monitoring, etc.
const BOT_NAMES = [
  // Search Engines
  "googlebot","google-inspectiontool","googleother","google-extended","google-safety",
  "googleproducer","google-site-verification","google-structured-data-testing-tool",
  "google-xrawler","googledocs","googleimageproxy","mediapartners-google","mediapartners",
  "adsbot-google","adsbot","apis-google","feedfetcher-google","google-read-aloud",
  "duplex","googleweblight","storebot-google",
  "bingbot","bingpreview","msnbot","msnbot-media","adidxbot","microsoftpreview",
  "binglocalsearch","microsoftdocs",
  "slurp","yahoo","yahoodirbot",
  "yandexbot","yandexaccessibilitybot","yandexblogs","yandexcalendar","yandexdirect",
  "yandexfavicons","yandexfordomain","yandeximages","yandexmarket","yandexmedia",
  "yandexmetrika","yandexnews","yandexpagechecker","yandexscreenshotbot","yandexturbo",
  "yandexvertis","yandexvideo","yandexwebmaster",
  "baiduspider","baiduspider-image","baiduspider-video","baiduspider-news",
  "duckduckbot","duckduckgo-favicons-bot","duckassistbot",
  "applebot","applebot-extended",
  "sogou","sosospider","exabot","qwantify","ia_archiver","seznam","seznambot","ccbot",
  "naver","yeti","coccoc","mojeekbot","petalbot","barkrowler","ecosia",

  // Social Media / Chat Previews
  "facebookexternalhit","facebookcatalog","facebot","meta-externalagent",
  "twitterbot","tweetmemebot","linkedinbot","linkedin",
  "whatsapp","telegrambot","telegram","discordbot",
  "slackbot","slack-imgproxy","slackbot-linkexpanding",
  "pinterest","pinterestbot","snapchat","viber","line","skypeuripreview",
  "redditbot","tumblr","instagram","micromessenger",
  "kakaotalk-scrap","kakaostory-og-reader","mastodon","zalobot","threema",

  // AI / LLM Crawlers
  "gptbot","chatgpt-user","oai-searchbot","claudebot","claude-web","anthropic-ai",
  "perplexitybot","cohere-ai","bytespider","bytedance","tiktokbot",
  "amazonbot","alexabot","apple-cloudkit","diffbot","neevabot","youbot","bravebot",
  "ai2bot","omgili","omgilibot","timpibot","velenpublicwebcrawler","kangaroobot",

  // SEO / Marketing Tools
  "ahrefsbot","ahrefssiteaudit",
  "semrushbot","semrushbot-ba","semrushbot-bm","semrushbot-ct","semrushbot-sa",
  "semrushbot-si","semrushbot-swa","splitpagesignalbot",
  "dotbot","rogerbot","mj12bot","majestic12","screaming frog seo spider",
  "sistrix","spyfu","serpstatbot","raventools","deepcrawl","contentkingapp",
  "sitebulb","oncrawl","brightedge","conductor","botify","seostar","dataforseo",
  "blexbot","blex","zoominfobot","hubspot","marketo","pardot","salesforce",

  // Monitoring / Uptime
  "uptimerobot","pingdom","statuscake","hetrixtools","site24x7","freshping",
  "updown.io","montastic","nodeping","checkhost","uptrends","uptimia",
  "datadog","newrelic","dynatrace","appdynamics","elastic","prometheus",
  "grafana","zabbix","nagios","prtg","solarwinds","thousandeyes",
  "catchpoint","rigor","keynote","kube-probe","elb-healthchecker","googlehc",
  "aws-health","azure-traffic-manager",
  "w3c_validator","w3c-checklink","linkchecker","deadlinkchecker",
  "brokenlinkcheck","linkwalker","checkbot",

  // Security Scanners
  "nessus","qualys","nmap","nikto","openvas","burpsuite","owasp","sqlmap",
  "dirbuster","gobuster","wpscan","nuclei","masscan","shodan","censys",
  "internetmeasurement","zgrab","zmapproject","securitytrails",

  // Feed Readers
  "feedly","feedparser","feedspot","newsblur","inoreader","theoldreader",
  "netvibes","feedbin","feedwrangler","miniflux","tiny tiny rss","liferea",
  "netnewswire","rssowl","feedreader","feedvalidator","universalfeedparser",
  "blogtrottr","superfeedr",

  // Archive / Research
  "archive.org_bot","wayback","turnitinbot","libwww","httrack","offline explorer",

  // CLI / HTTP Tools
  "curl","wget","httpie","aria2","lynx","links","elinks","w3m",

  // Headless Browsers / Automation
  "headlesschrome","headless","phantomjs","phantom","puppeteer","playwright",
  "selenium","webdriver","cypress","nightwatch","zombie","slimerjs",
  "htmlunit","mechanize","scrapy","nutch","heritrix","colly","goutte",

  // HTTP Libraries / SDKs
  "python-requests","python-urllib","python-httpx","aiohttp","httplib2","pycurl",
  "axios","node-fetch","undici","superagent","got/","needle","bent","phin",
  "go-http-client","go-resty","apache-httpclient","okhttp","jersey",
  "faraday","rest-client","typhoeus","lwp","libwww-perl","guzzlehttp","guzzle",
  "reqwest","alamofire","nsurlsession",

  // Scrapers / Content Extractors
  "sitesucker","webcopier","teleport","website-mirrorer","getright","grabber",
  "webzip","webscraper","dataminer","import.io","embedly","iframely","microlink",
  "unfurl","open-graph-scraper",

  // Email Pre-fetchers
  "googleimageproxy","yahoo-mailproxy","mailchimp","sendgrid","mailgun",
  "postmark","sparkpost","amazonses","mandrill","litmus","email on acid",
  "returnpath","250ok",

  // Preview / OG Fetchers
  "preview","embed","oembed","opengraph","og-image","metatags","link-preview",
  "card-fetch","vkshare","outbrain","taboola","flipboard","pocket",
  "instapaper","summify",

  // Generic Bot Identifiers
  "bot","crawl","spider","scraper","checker","scanner","monitor","analyzer",
  "inspector","validator",

  // Misc Known Bots
  "360spider","acunetix","addthis","cis455crawler","cliqzbot","cocolyzebot",
  "comodo","crawler4j","crystalsemanticsbot","daum","discobot","domaincrawler",
  "ezooms","fastbot","findlinks","gazebobot","gigabot","grapeshot","hatena",
  "icc-crawler","ichiro","infoseek","ips-agent","iskanie","jamesjbot",
  "jetslide","jooblebot","larbin","ltx71","mail.ru_bot","megaindex","moatbot",
  "moreover","multiviewbot","netcraft","netpeakspider","obot","openindexspider",
  "orangebot","pagepeeker","paperlibot","plukkie","pompos","postrank",
  "quora link preview","rankactivelinkbot","reaper","riddler","rivva","sbl-bot",
  "seokicks","seoscanners","siteexplorer","snap url preview","spbot",
  "startmebot","steeler","stq_bot","surveybot","tineye","toplistbot","traackr",
  "tweetedtimes","twengabot","urlappendbot","vagabondo","vebidoobot","voilabot",
  "wbsearchbot","web-archive","webalta","webceo","webmon","wesee","wikido",
  "woorank","woriobot","wotbox","xovibot","y!j-asr","yacybot","yisouspider","zumbot",
];

// Build single efficient regex from all patterns (deduplicated, longest-first)
const _unique = [...new Set(BOT_NAMES.map(b => b.toLowerCase()))].sort((a, b) => b.length - a.length);
const _esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const BOT_UA_PATTERN = new RegExp(_unique.map(_esc).join("|"), "i");

const PREFETCH_HEADERS = ["purpose", "x-purpose", "x-moz", "sec-purpose"] as const;
const PREFETCH_VALUES = /prefetch|prerender|preview/i;

function isBot(req: express.Request): boolean {
  if (req.method === "HEAD") return true;
  if (req.method !== "GET") return true;
  const ua = (req.headers["user-agent"] ?? "") as string;
  if (!ua || ua.length < 10) return true;
  if (BOT_UA_PATTERN.test(ua)) return true;
  for (const h of PREFETCH_HEADERS) {
    const v = req.headers[h];
    if (v && PREFETCH_VALUES.test(v as string)) return true;
  }
  return false;
}

// ─── Click Tracking (async, non-blocking) ────────────────
function hashIp(ip: string): string {
  const crypto = require("crypto");
  return crypto.createHash("sha256").update(ip + "snipr-salt").digest("hex").slice(0, 16);
}

async function trackClick(req: express.Request, link: LinkRecord): Promise<void> {
  try {
    const ip = ((req.headers["x-forwarded-for"] as string) || req.ip || "").split(",")[0].trim();
    const ipHash = ip ? hashIp(ip) : null;
    let country: string | null = null;
    let city: string | null = null;
    let device = "desktop";
    let browser: string | null = null;
    let os: string | null = null;
    const referrer = (req.headers.referer || req.headers.referrer || null) as string | null;
    const userAgent = (req.headers["user-agent"] || null) as string | null;
    const isQr = ["1", "true", "yes"].includes(String(req.query.qr || "").toLowerCase());

    const utmSource = (req.query.utm_source as string) || null;
    const utmMedium = (req.query.utm_medium as string) || null;
    const utmCampaign = (req.query.utm_campaign as string) || null;
    const utmTerm = (req.query.utm_term as string) || null;
    const utmContent = (req.query.utm_content as string) || null;

    try {
      const geoip = require("geoip-lite");
      const geo = geoip.lookup(ip);
      if (geo) { country = geo.country; city = geo.city; }
    } catch {}

    try {
      const { UAParser } = require("ua-parser-js");
      const ua = new UAParser(req.headers["user-agent"]).getResult();
      device = ua.device.type || "desktop";
      browser = ua.browser.name || null;
      os = ua.os.name || null;
    } catch {}

    await pool.query(
      `INSERT INTO click_events (id, link_id, timestamp, ip_hash, country, city, device, browser, os, referrer, user_agent, is_qr, utm_source, utm_medium, utm_campaign, utm_term, utm_content)
       VALUES (gen_random_uuid(), $1, NOW(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [link.id, ipHash, country, city, device, browser, os, referrer, userAgent, isQr, utmSource, utmMedium, utmCampaign, utmTerm, utmContent]
    );
  } catch (err) {
    logger.error({ err }, "Click tracking failed");
  }
}

// ─── HTML Pages ──────────────────────────────────────────
function landingPage(domain: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${domain} — Branded Short Domain</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🔗</text></svg>">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#f8f9fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Inter',sans-serif;color:#0a0a0a}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:20px;padding:48px 40px;width:100%;max-width:480px;margin:24px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.04)}
.icon-wrap{width:72px;height:72px;border-radius:50%;background:#f0fdf4;display:flex;align-items:center;justify-content:center;margin:0 auto 24px}
.icon-wrap svg{width:32px;height:32px;color:#10b981}
.badge{display:inline-flex;align-items:center;gap:6px;background:#ecfdf5;color:#059669;font-size:12px;font-weight:700;padding:5px 14px;border-radius:20px;margin-bottom:20px;letter-spacing:.5px}
.badge::before{content:'';width:6px;height:6px;background:#10b981;border-radius:50%}
h1{font-size:24px;font-weight:800;color:#0a0a0a;margin-bottom:24px;letter-spacing:-.5px}
h1::after{content:'';display:block;width:40px;height:3px;background:#e5e7eb;border-radius:2px;margin:16px auto 0}
.domain{font-weight:700;color:#0a0a0a}
.desc{font-size:14px;color:#6b7280;line-height:1.7;margin-bottom:8px}
.back-link{font-size:13px;color:#9ca3af}
.back-link a{color:#6b7280;text-decoration:underline;text-underline-offset:2px}
.back-link a:hover{color:#0a0a0a}
.divider{width:100%;height:1px;background:#f3f4f6;margin:28px 0}
.cta-text{font-size:15px;font-weight:600;color:#0a0a0a;margin-bottom:16px}
.btn{display:inline-flex;align-items:center;gap:8px;background:#0a0a0a;color:#fff;font-size:14px;font-weight:600;padding:12px 32px;border-radius:12px;text-decoration:none;transition:background .15s,transform .1s;letter-spacing:.3px}
.btn:hover{background:#1f1f1f;transform:translateY(-1px)}
.btn:active{transform:scale(.98)}
.footer{margin-top:32px;font-size:11px;color:#d1d5db;max-width:360px;line-height:1.6}
.powered{margin-top:16px;font-size:11px;color:#d1d5db}
.powered a{color:#9ca3af;text-decoration:none;font-weight:600}
.powered a:hover{color:#0a0a0a}
</style>
</head>
<body>
<div class="card">
  <div class="icon-wrap">
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
  </div>
  <div class="badge">ACTIVE</div>
  <h1>Branded Short Domain</h1>
  <p class="desc"><span class="domain">${domain}</span> is configured for link redirection.</p>
  <p class="back-link">If you arrived here by mistake, you can <a href="javascript:history.back()">go back</a>.</p>
  <div class="divider"></div>
  <p class="cta-text">Create your own branded short links</p>
  <a href="${SNIPR_URL}/signup" class="btn">GET STARTED</a>
</div>
<p class="footer">Domain owners can set up redirects for their main domain in Domain Settings for free</p>
<p class="powered">Powered by <a href="${SNIPR_URL}">Snipr</a></p>
</body>
</html>`;
}

function notFoundPage(domain: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Link Not Found — ${domain}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#f8f9fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Inter',sans-serif}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:20px;padding:48px 40px;width:100%;max-width:440px;margin:24px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.04)}
.icon-wrap{width:64px;height:64px;border-radius:50%;background:#fef2f2;display:flex;align-items:center;justify-content:center;margin:0 auto 20px}
.icon-wrap svg{width:28px;height:28px;color:#ef4444}
h1{font-size:22px;font-weight:800;color:#0a0a0a;margin-bottom:8px}
p{font-size:14px;color:#6b7280;line-height:1.6}
.back{margin-top:20px}
.back a{color:#6b7280;font-size:13px;text-decoration:underline;text-underline-offset:2px}
.back a:hover{color:#0a0a0a}
.powered{margin-top:24px;font-size:11px;color:#d1d5db}
.powered a{color:#9ca3af;text-decoration:none;font-weight:600}
.powered a:hover{color:#0a0a0a}
</style>
</head>
<body>
<div class="card">
  <div class="icon-wrap">
    <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
  </div>
  <h1>Link Not Found</h1>
  <p>This short link does not exist or has been removed from <strong>${domain}</strong>.</p>
  <p class="back"><a href="javascript:history.back()">Go back</a></p>
</div>
<p class="powered">Powered by <a href="${SNIPR_URL}">Snipr</a></p>
</body>
</html>`;
}

// ─── Subdomain Extraction ────────────────────────────────
function extractSubdomain(host: string): { subdomain: string | null; parent: string } {
  const parts = host.split(".");
  if (parts.length <= 2) return { subdomain: null, parent: host };
  return { subdomain: parts.slice(0, -2).join("."), parent: parts.slice(-2).join(".") };
}

// ─── Express App ─────────────────────────────────────────
const app = express();
app.set("trust proxy", true);
app.use(compression());
app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => (req as any).url === "/health" } }));

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "snipr-redirect", uptime: process.uptime() });
});

// ─── Main Redirect Handler ──────────────────────────────
app.use(async (req: express.Request, res: express.Response) => {
  if (req.method !== "GET" && req.method !== "HEAD") { res.status(405).send("Method Not Allowed"); return; }
  const rawHost = (req.headers["x-forwarded-host"] as string) || req.headers.host || "";
  const host = rawHost.split(":")[0].toLowerCase().trim();

  if (!host || !host.includes(".")) {
    res.status(400).send("Bad Request");
    return;
  }

  const slug = req.path.slice(1).split("/")[0];

  // Skip system files
  if (slug && (slug.includes(".") || slug === "favicon" || slug === "robots")) {
    res.status(404).send("");
    return;
  }

  // Look up domain
  let domainRecord = await lookupDomain(host);

  // Try parent domain for subdomain wildcard
  if (!domainRecord) {
    const { subdomain, parent } = extractSubdomain(host);
    if (subdomain) {
      domainRecord = await lookupParentDomain(parent);
    }
  }

  // Domain not registered in Snipr
  if (!domainRecord) {
    res.status(200).send(landingPage(host).replace("ACTIVE", "NOT CONFIGURED").replace("#ecfdf5", "#fef3c7").replace("#059669", "#d97706").replace("#10b981", "#f59e0b").replace("#f0fdf4", "#fffbeb"));
    return;
  }

  // Root path → landing page
  if (!slug) {
    res.status(200).send(landingPage(host));
    return;
  }

  // Look up link
  const link = await lookupLink(slug, domainRecord.id);

  if (!link || !link.enabled) {
    res.status(404).send(notFoundPage(host));
    return;
  }

  // Track click async — skip bots, crawlers, HEAD requests, prefetch
  if (!isBot(req)) {
    setImmediate(() => { trackClick(req, link).catch(() => {}); });
  }

  // Redirect
  res.redirect(301, link.destination_url);
});

// ─── Start ───────────────────────────────────────────────
app.listen(PORT, () => {
  logger.info({ port: PORT }, "Snipr Redirect Server listening");
});
