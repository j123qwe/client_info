// ip-info — Node.js port of the Cloudflare Worker "Client Info" page.
// Runs as a plain HTTP server for Kubernetes. No Cloudflare `request.cf`
// object exists here, so geo/ASN data comes from (in order):
//   1. Cloudflare headers, if the site is proxied through Cloudflare
//   2. Optional MaxMind GeoLite2 .mmdb files mounted into the pod
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import net from "node:net";

const PORT = parseInt(process.env.PORT || "8080", 10);

// Populated via the Kubernetes downward API (see k8s/deployment.yaml).
// POD_NAME falls back to the hostname, which equals the pod name in K8s.
const POD_NAME = process.env.POD_NAME || os.hostname();
const POD_NAMESPACE = process.env.POD_NAMESPACE || "";
const NODE_NAME = process.env.NODE_NAME || "";
const POD_IP = process.env.POD_IP || "";

// ---------- Optional GeoIP (MaxMind GeoLite2) ----------
let cityDb = null;
let asnDb = null;

async function loadGeo() {
  const cityPath = process.env.GEOIP_CITY_DB || "/geoip/GeoLite2-City.mmdb";
  const asnPath = process.env.GEOIP_ASN_DB || "/geoip/GeoLite2-ASN.mmdb";
  if (!fs.existsSync(cityPath) && !fs.existsSync(asnPath)) {
    console.log("GeoIP databases not found; geo fields will rely on Cloudflare headers only");
    return;
  }
  let open;
  try {
    const mm = await import("maxmind");
    open = mm.open || mm.default?.open;
  } catch (e) {
    console.log("maxmind module unavailable; GeoIP disabled:", e.message);
    return;
  }
  for (const [path, set] of [
    [cityPath, db => (cityDb = db)],
    [asnPath, db => (asnDb = db)],
  ]) {
    if (!fs.existsSync(path)) continue;
    try {
      set(await open(path));
      console.log("Loaded GeoIP database:", path);
    } catch (e) {
      console.log("Failed to load", path, "-", e.message);
    }
  }
}

function geoLookup(ip) {
  const out = {};
  if (!net.isIP(ip)) return out;
  try {
    const c = cityDb?.get(ip);
    if (c) {
      out.country = c.country?.iso_code;
      out.continent = c.continent?.code;
      out.region = c.subdivisions?.[0]?.names?.en;
      out.regionCode = c.subdivisions?.[0]?.iso_code;
      out.city = c.city?.names?.en;
      out.postalCode = c.postal?.code;
      out.latitude = c.location?.latitude;
      out.longitude = c.location?.longitude;
      out.timezone = c.location?.time_zone;
      out.isEUCountry = !!c.country?.is_in_european_union;
    }
    const a = asnDb?.get(ip);
    if (a) {
      out.asn = a.autonomous_system_number;
      out.asOrganization = a.autonomous_system_organization;
    }
  } catch { /* ignore lookup errors */ }
  return out;
}

// ---------- Helpers ----------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function header(req, name) {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v.join(", ") : (v || "");
}

function clientIp(req) {
  const xffFirst = header(req, "X-Forwarded-For").split(",")[0].trim();
  let ip =
    header(req, "CF-Connecting-IP") ||
    header(req, "X-Real-IP") ||
    xffFirst ||
    req.socket.remoteAddress ||
    "Unknown";
  if (ip.startsWith("::ffff:") && net.isIPv4(ip.slice(7))) ip = ip.slice(7);
  return ip;
}

function send(res, status, body, headers) {
  res.writeHead(status, { "Content-Length": Buffer.byteLength(body), ...headers });
  res.end(body);
}

// ---------- Request handler ----------
function handle(req, res) {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/healthz") {
    return send(res, 200, "ok\n", { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  }

  const ip = clientIp(req);
  const geo = geoLookup(ip);

  // Cloudflare headers win when present (site proxied through CF)
  const cfCountry = header(req, "CF-IPCountry");
  const cfRay = header(req, "CF-Ray");
  const colo = cfRay.includes("-") ? cfRay.split("-").pop() : "";

  const forwardedFor = header(req, "X-Forwarded-For");
  const forwardedProto = header(req, "X-Forwarded-Proto");
  const userAgent = header(req, "User-Agent") || "Unknown";
  const referer = header(req, "Referer");
  const acceptLanguage = header(req, "Accept-Language");
  const acceptEncoding = header(req, "Accept-Encoding");
  const accept = header(req, "Accept");
  const host = header(req, "X-Forwarded-Host") || header(req, "Host");
  const method = req.method;
  const protocol = (forwardedProto || (req.socket.encrypted ? "https" : "http")) + ":";
  const httpVersion = "HTTP/" + req.httpVersion + (forwardedProto ? " (pod-side, behind proxy)" : "");

  const country = cfCountry || geo.country || "Unknown";
  const continent = geo.continent || "";
  const city = geo.city || "Unknown";
  const region = geo.region || "";
  const regionCode = geo.regionCode || "";
  const postalCode = geo.postalCode || "";
  const timezone = geo.timezone || "";
  const latitude = geo.latitude != null ? String(geo.latitude) : "";
  const longitude = geo.longitude != null ? String(geo.longitude) : "";
  const asn = geo.asn != null ? "AS" + geo.asn : "Unknown";
  const asOrganization = geo.asOrganization || "Unknown";
  const isEUCountry = !!geo.isEUCountry;

  const ipType = ip.includes(":") ? "IPv6" : "IPv4";
  const servedBy = POD_NAMESPACE ? POD_NAMESPACE + "/" + POD_NAME : POD_NAME;

  const data = [
    { label: "IP Address", value: ip, highlight: true },
    { label: "IP Version", value: ipType },
    { label: "Forwarded For", value: forwardedFor || "None" },
    { label: "Served By (Pod)", value: servedBy, pod: true },
    ...(NODE_NAME ? [{ label: "K8s Node", value: NODE_NAME }] : []),
    ...(POD_IP ? [{ label: "Pod IP", value: POD_IP }] : []),
    { label: "Country", value: country + (continent ? " (" + continent + ")" : "") },
    { label: "Region", value: (region || "Unknown") + (regionCode ? " (" + regionCode + ")" : "") },
    { label: "City", value: city },
    { label: "Postal Code", value: postalCode || "Unknown" },
    { label: "Coordinates", value: (latitude && longitude) ? latitude + ", " + longitude : "Unknown" },
    { label: "Timezone", value: timezone || "Unknown" },
    { label: "ASN", value: asn },
    { label: "ISP / Organization", value: asOrganization },
    { label: "EU Country", value: isEUCountry ? "Yes" : "No" },
    ...(colo ? [{ label: "Cloudflare Datacenter", value: colo }] : []),
    { label: "HTTP Version", value: httpVersion },
    { label: "Request Method", value: method },
    { label: "Protocol", value: protocol },
    { label: "Host", value: host },
    { label: "User-Agent", value: userAgent },
    { label: "Accept", value: accept || "Unknown" },
    { label: "Accept-Language", value: acceptLanguage || "Unknown" },
    { label: "Accept-Encoding", value: acceptEncoding || "Unknown" },
    { label: "Referer", value: referer || "None" },
  ];

  // JSON API endpoint — great for curl/jq
  if (url.pathname === "/json") {
    const jsonData = {
      ip,
      ip_version: ipType,
      forwarded_for: forwardedFor || null,
      pod_name: POD_NAME,
      pod_namespace: POD_NAMESPACE || null,
      node_name: NODE_NAME || null,
      pod_ip: POD_IP || null,
      country,
      continent: continent || null,
      region: region || null,
      region_code: regionCode || null,
      city: geo.city || null,
      postal_code: postalCode || null,
      latitude: latitude || null,
      longitude: longitude || null,
      timezone: timezone || null,
      asn,
      as_organization: asOrganization,
      is_eu_country: isEUCountry,
      cloudflare_datacenter: colo || null,
      http_version: httpVersion,
      request_method: method,
      protocol,
      host,
      user_agent: userAgent,
      accept: accept || null,
      accept_language: acceptLanguage || null,
      accept_encoding: acceptEncoding || null,
      referer: referer || null,
    };
    return send(res, 200, JSON.stringify(jsonData, null, 2) + "\n", {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Served-By": POD_NAME,
    });
  }

  // Plain text endpoints — for scripts
  if (url.pathname === "/ip") {
    return send(res, 200, ip + "\n", {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Served-By": POD_NAME,
    });
  }
  if (url.pathname === "/pod") {
    return send(res, 200, POD_NAME + "\n", {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Served-By": POD_NAME,
    });
  }

  // HTML page
  const rows = data.map(d => {
    const cls = d.highlight ? "row highlight" : d.pod ? "row pod" : "row";
    return '<div class="' + cls + '"><span class="label">' + escapeHtml(d.label) + '</span><span class="value">' + escapeHtml(d.value) + "</span></div>";
  }).join("");

  const json = JSON.stringify(Object.fromEntries(data.map(d => [d.label, d.value])), null, 2);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="referrer" content="no-referrer">
<title>Client Info</title>
<style>
  :root { --bg: #0b0f1a; --card: #141b2d; --accent: #f6821f; --text: #e6e9f0; --muted: #8b95a7; --border: #2a3450; --green: #2ecc71; --blue: #4ea1ff; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: 2rem 1rem; }
  h1 { font-size: 1.6rem; font-weight: 700; margin-bottom: 1rem; }
  h1 span { color: var(--accent); }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; width: 100%; max-width: 640px; overflow: hidden; }
  .row { display: flex; justify-content: space-between; align-items: flex-start; padding: .75rem 1.1rem; border-bottom: 1px solid var(--border); gap: 1rem; }
  .row:last-child { border-bottom: none; }
  .row.highlight { background: rgba(246,130,31,.07); }
  .row.highlight .value { color: var(--accent); font-weight: 700; font-size: 1.15rem; }
  .row.pod { background: rgba(78,161,255,.07); }
  .row.pod .value { color: var(--blue); font-weight: 700; }
  .label { color: var(--muted); font-size: .85rem; white-space: nowrap; padding-top: .1rem; }
  .value { text-align: right; word-break: break-all; font-size: .9rem; font-family: "SF Mono", "Fira Code", "Consolas", monospace; }
  .tabs { display: flex; gap: .5rem; margin-bottom: 1rem; max-width: 640px; width: 100%; }
  .tab { background: var(--card); border: 1px solid var(--border); color: var(--muted); padding: .5rem 1.2rem; border-radius: 8px; cursor: pointer; font-size: .85rem; font-weight: 600; transition: all .15s; }
  .tab.active { background: var(--accent); color: #1a1208; border-color: var(--accent); }
  .tab:hover:not(.active) { color: var(--text); }
  #jsonView { display: none; background: var(--card); border: 1px solid var(--border); border-radius: 12px; width: 100%; max-width: 640px; padding: 1.1rem; overflow-x: auto; white-space: pre; font-family: "SF Mono","Fira Code","Consolas",monospace; font-size: .82rem; line-height: 1.5; color: var(--green); }
  #jsonView.visible { display: block; }
  .card.hidden { display: none; }
  .copy-btn { background: var(--accent); color: #1a1208; border: none; padding: .45rem 1rem; border-radius: 6px; cursor: pointer; font-size: .8rem; font-weight: 600; margin-top: .75rem; }
  .copy-btn:hover { opacity: .85; }
  #toast { position: fixed; bottom: 2rem; left: 50%; transform: translateX(-50%); background: var(--green); color: #0b0f1a; padding: .6rem 1.4rem; border-radius: 8px; font-weight: 600; font-size: .85rem; opacity: 0; transition: opacity .25s; pointer-events: none; }
  #toast.show { opacity: 1; }
  .api-hint { margin-top: 1rem; color: var(--muted); font-size: .8rem; text-align: center; max-width: 640px; line-height: 1.8; }
  .api-hint code { background: var(--card); padding: .15rem .4rem; border-radius: 4px; border: 1px solid var(--border); color: var(--accent); font-size: .78rem; }
</style>
</head>
<body>
  <h1>Client <span>Info</span></h1>
  <div class="tabs">
    <button class="tab active" id="tabCard" onclick="showCard()">Card View</button>
    <button class="tab" id="tabJson" onclick="showJson()">JSON View</button>
  </div>
  <div class="card" id="cardView">
    ${rows}
  </div>
  <pre id="jsonView">${escapeHtml(json)}</pre>
  <button class="copy-btn" onclick="copyJson()">Copy JSON</button>
  <div class="api-hint">API: <code>/json</code> &nbsp; <code>/ip</code> &nbsp; <code>/pod</code></div>
  <div id="toast"></div>
<script>
  function showCard() {
    document.getElementById("cardView").classList.remove("hidden");
    document.getElementById("jsonView").classList.remove("visible");
    document.getElementById("tabCard").classList.add("active");
    document.getElementById("tabJson").classList.remove("active");
  }
  function showJson() {
    document.getElementById("cardView").classList.add("hidden");
    document.getElementById("jsonView").classList.add("visible");
    document.getElementById("tabCard").classList.remove("active");
    document.getElementById("tabJson").classList.add("active");
  }
  function copyJson() {
    var text = document.getElementById("jsonView").textContent;
    navigator.clipboard.writeText(text).then(function() {
      var t = document.getElementById("toast");
      t.textContent = "Copied to clipboard!";
      t.classList.add("show");
      setTimeout(function() { t.classList.remove("show"); }, 1800);
    });
  }
</script>
</body>
</html>`;

  return send(res, 200, html, {
    "Content-Type": "text/html; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "X-Served-By": POD_NAME,
  });
}

// ---------- Startup / shutdown ----------
await loadGeo();

const server = http.createServer((req, res) => {
  try {
    handle(req, res);
  } catch (e) {
    console.error("Request error:", e);
    if (!res.headersSent) send(res, 500, "Internal Server Error\n", { "Content-Type": "text/plain" });
  }
});
server.keepAliveTimeout = 65_000;
server.listen(PORT, () => console.log(`ip-info listening on :${PORT} as pod ${POD_NAME}`));

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    console.log(`${sig} received, draining connections`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
