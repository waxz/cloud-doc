// A tiny in-memory WebDAV server for tests: enough of the protocol for
// what Cloud Doc does (MKCOL, PUT, GET with Range, DELETE, PROPFIND).
// Like most real servers, a PUT whose parent folder is missing fails with 409.
// Usage: startWebDav({ port, user, pass }) → { url, files, close }
import http from 'node:http';

export function startWebDav({ port = 0, user = 'dav', pass = 'davpass' } = {}) {
  const files = new Map(); // path → { body: Buffer, type }
  const dirs = new Set(['/']);
  const auth = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  const parent = (p) => p.replace(/\/[^/]+\/?$/, '/') || '/';

  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== auth) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="test"' });
      return res.end();
    }
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const dir = path.endsWith('/') ? path : `${path}/`;
    switch (req.method) {
      case 'MKCOL':
        if (dirs.has(dir)) return res.writeHead(405).end();
        if (!dirs.has(parent(dir))) return res.writeHead(409).end();
        dirs.add(dir);
        return res.writeHead(201).end();
      case 'PUT':
        if (!dirs.has(parent(path))) return res.writeHead(409).end();
        files.set(path, { body, type: req.headers['content-type'] ?? 'application/octet-stream' });
        return res.writeHead(201).end();
      case 'GET': {
        const f = files.get(path);
        if (!f) return res.writeHead(404).end();
        const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
        if (m) {
          const start = m[1] ? Number(m[1]) : f.body.length - Number(m[2]);
          const end = m[1] && m[2] ? Math.min(Number(m[2]), f.body.length - 1) : f.body.length - 1;
          res.writeHead(206, {
            'content-type': f.type,
            'content-length': end - start + 1,
            'content-range': `bytes ${start}-${end}/${f.body.length}`,
            'accept-ranges': 'bytes',
          });
          return res.end(f.body.subarray(start, end + 1));
        }
        res.writeHead(200, { 'content-type': f.type, 'content-length': f.body.length, 'accept-ranges': 'bytes' });
        return res.end(f.body);
      }
      case 'DELETE': {
        let found = files.delete(path);
        for (const k of [...files.keys()]) if (k.startsWith(dir)) (files.delete(k), (found = true));
        for (const d of [...dirs]) if (d.startsWith(dir) && d !== '/') (dirs.delete(d), (found = true));
        return res.writeHead(found ? 204 : 404).end();
      }
      case 'PROPFIND':
        if (!dirs.has(dir) && !files.has(path)) return res.writeHead(404).end();
        res.writeHead(207, { 'content-type': 'application/xml' });
        {
          // Depth 1 lists the folder's direct children too, like real servers.
          const self = [`<d:response><d:href>${path}</d:href></d:response>`];
          if (req.headers.depth === '1' && dirs.has(dir)) {
            for (const d of dirs) if (d !== dir && d.startsWith(dir) && !d.slice(dir.length).replace(/\/$/, '').includes('/')) self.push(`<d:response><d:href>${d.endsWith('/') ? d : `${d}/`}</d:href></d:response>`);
            for (const f of files.keys()) if (f.startsWith(dir) && !f.slice(dir.length).includes('/')) self.push(`<d:response><d:href>${f}</d:href></d:response>`);
          }
          return res.end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${self.join('')}</d:multistatus>`);
        }
      default:
        return res.writeHead(405).end();
    }
  });
  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () =>
      resolve({ url: `http://127.0.0.1:${server.address().port}`, user, pass, files, close: () => server.close() })
    )
  );
}

// Run on its own for local development: node test/webdav-server.mjs [port]
if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await startWebDav({ port: Number(process.argv[2] ?? 8793) });
  console.log(`WebDAV at ${s.url} (user ${s.user}, password ${s.pass})`);
}
