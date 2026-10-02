'use strict';

/** Tiny JSON client for the lab control server, shared by the lab tests (not a test file itself). */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

/** Read `<hive>/lab-control.json` the way a lab client does and return a `call(method, path, body)` function. */
function clientFromControlFile(hiveDir) {
  const info = JSON.parse(fs.readFileSync(path.join(hiveDir, 'lab-control.json'), 'utf8'));
  const call = (method, p, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = { authorization: `Bearer ${info.token}` };
    if (payload !== undefined) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(payload); }
    const r = http.request({ host: info.host, port: info.port, method, path: p, headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* not json */ } resolve({ status: res.statusCode, json }); });
    });
    r.on('error', reject);
    if (payload !== undefined) r.write(payload);
    r.end();
  });
  return { info, call };
}

module.exports = { clientFromControlFile };
