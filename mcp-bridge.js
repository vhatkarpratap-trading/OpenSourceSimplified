#!/usr/bin/env node
'use strict';
const net = require('net');
const fs  = require('fs');

const PATH_FILE = '/tmp/rex-canvas-mcp.sock.path';
const MAX_RETRIES = 25; // 5 seconds total at 200ms intervals

function connect(attempt) {
  let sockPath;
  try { sockPath = fs.readFileSync(PATH_FILE, 'utf8').trim(); } catch {}

  if (!sockPath) {
    if (attempt >= MAX_RETRIES) {
      process.stderr.write('rex-mcp-bridge: socket path file not found — is the app running?\n');
      process.exit(1);
    }
    return setTimeout(() => connect(attempt + 1), 200);
  }

  const sock = net.createConnection(sockPath);

  sock.on('error', (err) => {
    if (attempt >= MAX_RETRIES) {
      process.stderr.write('rex-mcp-bridge: ' + err.message + '\n');
      process.exit(1);
    }
    setTimeout(() => connect(attempt + 1), 200);
  });

  sock.on('connect', () => {
    process.stdin.pipe(sock);
    sock.pipe(process.stdout);
    process.stdin.on('end', () => sock.end());
    sock.on('end', () => process.exit(0));
  });
}

connect(0);
