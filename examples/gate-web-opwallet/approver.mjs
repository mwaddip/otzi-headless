#!/usr/bin/env node
//
// Standalone external gate approver for the otzi-headless daemon.
//
// This service sits between the daemon and an operator. It exposes a webhook
// endpoint that the daemon's `webhook` gate strategy POSTs `CeremonySpec`
// JSON to, and it exposes an operator-facing HTTP UI where a human signs an
// approve/reject decision with their ML-DSA-44 key (via OPWallet or any
// ML-DSA-44 implementation).
//
// The daemon itself is agnostic to this approver — it only knows the
// webhook URL and the standard webhook contract (POST JSON, expect
// `{ "decision": "approve" | "reject" }` back). ML-DSA verification lives
// here, not in the daemon.
//
// Architecture:
//
//   daemon ──POST /webhook (CeremonySpec)──▶ approver.mjs
//                                             │  hold response, add to pending
//                                             │
//                                           operator's browser
//                                             │  GET  /            (UI)
//                                             │  GET  /pending     (list)
//                                             │  POST /decide      (signed)
//                                             │
//                                           approver.mjs ──{ decision }──▶ daemon
//
// Configure:
//
//   [gate]
//   strategy = "webhook"
//   [gate.params]
//   url = "http://approver:8181/webhook"
//   timeout_sec = 86400
//
// Environment variables for the approver:
//   APPROVER_LISTEN         host:port  (default "0.0.0.0:8181")
//   APPROVER_PUBKEY_HEX     ML-DSA-44 pubkey, 2624 hex chars (REQUIRED)
//   APPROVER_HTML_FILE      path to UI HTML (default sibling "index.html")
//
// Run with `node examples/gate-web-opwallet/approver.mjs` from the repo root
// (the script imports `@btc-vision/post-quantum/ml-dsa.js` from node_modules).

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ml_dsa44 } from '@btc-vision/post-quantum/ml-dsa.js';

const SALT = 'otzi-headless:gate-decision:v1';
const NONCE_BYTES = 32;
const MLDSA44_PUBKEY_BYTES = 1312;

const listen = process.env.APPROVER_LISTEN ?? '0.0.0.0:8181';
const pubkeyHex = process.env.APPROVER_PUBKEY_HEX;
if (!pubkeyHex) {
  console.error('approver: APPROVER_PUBKEY_HEX is required (1312-byte ML-DSA-44 pubkey, 2624 hex chars)');
  process.exit(1);
}
const operatorPubKey = hexToBytes(pubkeyHex);
if (operatorPubKey.length !== MLDSA44_PUBKEY_BYTES) {
  console.error(`approver: APPROVER_PUBKEY_HEX must decode to ${MLDSA44_PUBKEY_BYTES} bytes, got ${operatorPubKey.length}`);
  process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const htmlFile = process.env.APPROVER_HTML_FILE ?? join(__dirname, 'index.html');
const html = readFileSync(htmlFile, 'utf8');

// Pending: ceremonyId → { spec, nonce, res (daemon's webhook response) }
const pending = new Map();
const usedNonces = new Set();

const { host, port } = parseListen(listen);

const server = createServer((req, res) => {
  const url = req.url ?? '/';

  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  if (req.method === 'GET' && url === '/pending') {
    const out = [];
    for (const [ceremonyId, entry] of pending) {
      out.push({ ceremonyId, nonce: bytesToHex(entry.nonce), spec: entry.spec });
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
    return;
  }
  if (req.method === 'POST' && url === '/webhook') {
    handleWebhook(req, res);
    return;
  }
  if (req.method === 'POST' && url === '/decide') {
    handleDecide(req, res);
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(port, host, () => {
  const addr = server.address();
  console.log(`approver: listening on http://${addr.address}:${addr.port}`);
});

function handleWebhook(req, res) {
  readBody(req).then((body) => {
    let spec;
    try {
      spec = JSON.parse(body);
    } catch {
      return respondJson(res, 400, { error: 'body is not JSON' });
    }
    if (!spec || typeof spec !== 'object' || typeof spec.ceremonyId !== 'string') {
      return respondJson(res, 400, { error: "spec missing 'ceremonyId'" });
    }

    const nonce = randomBytes(NONCE_BYTES);
    pending.set(spec.ceremonyId, { spec, nonce, res });
    console.log(`approver: pending ceremony '${spec.ceremonyId}' (nonce=${bytesToHex(nonce)})`);

    // Clean up if daemon aborts the webhook request before the operator decides.
    req.on('close', () => {
      if (pending.get(spec.ceremonyId)?.res === res) {
        pending.delete(spec.ceremonyId);
        console.log(`approver: webhook closed by daemon — dropped '${spec.ceremonyId}'`);
      }
    });
    // The response stays open until handleDecide calls res.end.
  }).catch((err) => respondJson(res, 400, { error: `read body: ${err.message}` }));
}

function handleDecide(req, res) {
  readBody(req).then((body) => {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return respondJson(res, 400, { error: 'body is not JSON' });
    }
    const { ceremonyId, decision, nonce: nonceHex, signatureHex } = parsed ?? {};
    if (typeof ceremonyId !== 'string')
      return respondJson(res, 400, { error: 'ceremonyId must be a string' });
    if (decision !== 'approve' && decision !== 'reject')
      return respondJson(res, 400, { error: "decision must be 'approve' or 'reject'" });
    if (typeof nonceHex !== 'string' || !/^[0-9a-fA-F]+$/.test(nonceHex))
      return respondJson(res, 400, { error: 'nonce must be a hex string' });
    if (typeof signatureHex !== 'string' || !/^[0-9a-fA-F]+$/.test(signatureHex))
      return respondJson(res, 400, { error: 'signatureHex must be a hex string' });

    const entry = pending.get(ceremonyId);
    if (!entry) return respondJson(res, 404, { error: `no pending ceremony '${ceremonyId}'` });

    const asserted = hexToBytes(nonceHex);
    if (asserted.length !== NONCE_BYTES || !constantTimeEqual(asserted, entry.nonce))
      return respondJson(res, 403, { error: 'nonce mismatch' });

    if (usedNonces.has(nonceHex))
      return respondJson(res, 403, { error: 'nonce already used' });

    const payload = buildSignedPayload(ceremonyId, decision, entry.nonce);
    const signature = hexToBytes(signatureHex);
    const ok = ml_dsa44.verify(signature, payload, operatorPubKey);
    if (!ok) return respondJson(res, 403, { error: 'signature verification failed' });

    // Passed. Resolve the held webhook response with the decision.
    pending.delete(ceremonyId);
    usedNonces.add(nonceHex);
    respondJson(entry.res, 200, { decision });
    console.log(`approver: ${decision} for '${ceremonyId}'`);

    respondJson(res, 200, { ok: true, ceremonyId, decision });
  }).catch((err) => respondJson(res, 400, { error: `read body: ${err.message}` }));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSignedPayload(ceremonyId, decision, nonce) {
  const saltBytes = new TextEncoder().encode(SALT);
  const ceremonyIdBytes = new TextEncoder().encode(ceremonyId);
  const decisionByte = decision === 'approve' ? 0x01 : 0x00;
  const out = new Uint8Array(saltBytes.length + ceremonyIdBytes.length + 1 + nonce.length);
  out.set(saltBytes, 0);
  out.set(ceremonyIdBytes, saltBytes.length);
  out[saltBytes.length + ceremonyIdBytes.length] = decisionByte;
  out.set(nonce, saltBytes.length + ceremonyIdBytes.length + 1);
  return out;
}

function parseListen(s) {
  const idx = s.lastIndexOf(':');
  const host = idx === 0 ? '0.0.0.0' : s.slice(0, idx);
  const port = parseInt(s.slice(idx + 1), 10);
  if (!Number.isFinite(port)) {
    console.error(`approver: APPROVER_LISTEN malformed (got '${s}')`);
    process.exit(1);
  }
  return { host, port };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        req.destroy();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function respondJson(res, status, body) {
  if (res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function hexToBytes(hex) {
  if (hex.length % 2 !== 0) return new Uint8Array(0);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return out;
}

function bytesToHex(bytes) {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`approver: ${sig} received, shutting down`);
    server.close(() => process.exit(0));
    // Fail pending webhooks so the daemon sees an error (not an indefinite hang).
    for (const entry of pending.values()) {
      respondJson(entry.res, 503, { error: 'approver shutting down' });
    }
  });
}
