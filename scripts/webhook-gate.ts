// A tiny local forwarder that lets ONE thing through a public tunnel: Paystack's webhook.
//
// Why: `ngrok http 3002` would put the whole dev app on the internet (sign-in, checkout, everything,
// including seeded test accounts whose password is in the repo). Point ngrok at THIS instead:
//
//   npm run dev:webhook-gate          (listens on 127.0.0.1:3991)
//   ngrok http 3991
//
// It forwards exactly `POST /api/webhooks/paystack` to the app and answers 404 to everything else,
// without ever contacting the app for those. The webhook itself is still protected by Paystack's
// signature; the gate only shrinks what a stranger who finds the tunnel address can reach.
//
// Built on node's own http module (no packages). Bodies are capped at 64 KB. It never logs bodies,
// headers or the signature.
import http from "node:http";

const LISTEN_HOST = "127.0.0.1";
const LISTEN_PORT = Number(process.env.GATE_PORT ?? 3991);
const UPSTREAM_HOST = "127.0.0.1";
const UPSTREAM_PORT = Number(process.env.GATE_UPSTREAM_PORT ?? 3002);
// The ONLY route that is forwarded. The upstream path is always this constant, never taken from the request.
const ALLOWED_PATH = "/api/webhooks/paystack";
const MAX_BODY_BYTES = 64 * 1024;
const UPSTREAM_TIMEOUT_MS = 20_000;
// Headers that are passed on. Everything else (cookies, authorization, ngrok's own headers ...) is dropped.
const FORWARDED_HEADERS = ["content-type", "x-paystack-signature", "user-agent", "x-forwarded-for"];

function log(line: string) {
  console.log(`${new Date().toISOString()} ${line}`);
}

function reply(res: http.ServerResponse, status: number, body = "") {
  res.writeHead(status, { "Content-Type": "text/plain", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer((req, res) => {
  // Exact match only: no query string, no trailing slash, no other method. Anything else is a 404 that
  // does not reveal whether the route exists, and never reaches the app.
  if (req.method !== "POST" || req.url !== ALLOWED_PATH) {
    log(`blocked ${req.method}`);
    req.resume();
    reply(res, 404);
    return;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;

  req.on("data", (chunk: Buffer) => {
    if (tooLarge) return;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      tooLarge = true;
      chunks.length = 0;
      log("blocked (body too large)");
      reply(res, 413);
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on("end", () => {
    if (tooLarge) return;
    const body = Buffer.concat(chunks);

    const headers: Record<string, string> = { host: `localhost:${UPSTREAM_PORT}`, "content-length": String(body.length) };
    for (const name of FORWARDED_HEADERS) {
      const value = req.headers[name];
      if (typeof value === "string") headers[name] = value;
    }

    const upstream = http.request(
      { host: UPSTREAM_HOST, port: UPSTREAM_PORT, path: ALLOWED_PATH, method: "POST", headers, timeout: UPSTREAM_TIMEOUT_MS },
      (upstreamRes) => {
        const parts: Buffer[] = [];
        upstreamRes.on("data", (c: Buffer) => parts.push(c));
        upstreamRes.on("end", () => {
          const out = Buffer.concat(parts);
          log(`forwarded ${body.length} bytes -> ${upstreamRes.statusCode}`);
          res.writeHead(upstreamRes.statusCode ?? 502, {
            "Content-Type": upstreamRes.headers["content-type"] ?? "text/plain",
            "Content-Length": out.length,
          });
          res.end(out);
        });
      },
    );
    upstream.on("timeout", () => upstream.destroy(new Error("upstream timeout")));
    upstream.on("error", (error) => {
      log(`upstream error: ${error.message}`);
      if (!res.headersSent) reply(res, 502);
    });
    upstream.end(body);
  });

  req.on("error", () => {
    if (!res.headersSent) reply(res, 400);
  });
});

// Slow or stalled clients cannot hold connections open.
server.headersTimeout = 10_000;
server.requestTimeout = 15_000;

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  log(`webhook gate listening on http://${LISTEN_HOST}:${LISTEN_PORT}; forwarding ONLY POST ${ALLOWED_PATH} to ${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
});
