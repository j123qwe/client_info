# Client Info

A small Node.js HTTP service that displays request and client-network information. It provides an HTML page for interactive use and plain-text/JSON endpoints for scripts and health checks.

## Run locally

Requires Node.js 22 or later.

```sh
npm install
npm start
```

The service listens on port `8080` by default. Open <http://localhost:8080> to view the page. Set `PORT` to use a different port:

```sh
PORT=3000 npm start
```

## Run with Docker

```sh
docker build -t ip-info .
docker run --rm -p 8080:8080 ip-info
```

Then open <http://localhost:8080>. The image uses Node.js 22 Alpine, runs as the non-root `node` user, and exposes port `8080`.

## Endpoints

| Path | Description |
| --- | --- |
| `/` | HTML client information page with card and JSON views |
| `/json` | Request and client information as JSON |
| `/ip` | Detected client IP address as plain text |
| `/pod` | Serving pod name as plain text |
| `/healthz` | Health check; returns `ok` |

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8080` | HTTP listen port |
| `POD_NAME` | System hostname | Pod name shown in responses |
| `POD_NAMESPACE` | Empty | Kubernetes namespace; when set, the page shows `namespace/pod-name` |
| `NODE_NAME` | Empty | Kubernetes node name, included when set |
| `POD_IP` | Empty | Pod IP, included when set |
| `GEOIP_CITY_DB` | `/geoip/GeoLite2-City.mmdb` | Optional MaxMind GeoLite2 City database path |
| `GEOIP_ASN_DB` | `/geoip/GeoLite2-ASN.mmdb` | Optional MaxMind GeoLite2 ASN database path |

GeoIP databases are optional. When present and readable, they provide location and ASN details for the detected IP. Without them, country and Cloudflare datacenter information can still come from Cloudflare headers; other GeoIP-derived fields remain unknown. The service does not download or include MaxMind databases. Obtain and mount the databases in accordance with MaxMind's terms.

For Docker, mount a directory containing the default database filenames at `/geoip`:

```sh
docker run --rm -p 8080:8080 \\
  -v /path/to/geoip:/geoip:ro \\
  ip-info
```

## Client IP and proxy headers

The reported client IP is selected from `CF-Connecting-IP`, then the first address in `X-Forwarded-For`, then `X-Real-IP`, and finally the socket's remote address. Cloudflare country and datacenter headers are also used when present. Forwarded headers should only be trusted when requests reach the service through a trusted proxy that sets or sanitizes them.
