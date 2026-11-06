const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream');

const port = process.argv[2] || 3000;
const DIR = path.join(__dirname, 'download');
const TEMP_SUFFIX = '.uploading';

fs.mkdirSync(DIR, { recursive: true });

http.createServer(requestHandler).listen(port, () => {
  console.log('Server is listening on:');
  console.log('  http://localhost:' + port);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list) {
      if (net.family === 'IPv4' && !net.internal) console.log('  http://' + net.address + ':' + port);
    }
  }
});

function requestHandler(req, res) {
  const url = req.url.split('?')[0];
  let match;
  if (req.method === 'GET' && url === '/') {
    sendIndexHtml(res);
  } else if (req.method === 'GET' && url === '/list') {
    sendFileList(res);
  } else if (req.method === 'GET' && (match = url.match(/^\/download\/([^\/]+)$/))) {
    sendFile(match[1], res);
  } else if ((req.method === 'POST' || req.method === 'PUT') && (match = url.match(/^\/upload\/([^\/]+)$/))) {
    saveFile(match[1], req, res);
  } else {
    send(res, 400, 'Invalid request');
  }
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

// The client sends the relative path (e.g. "photos/my trip.jpg") as one encoded URL segment.
// Returns an absolute path inside DIR, or null if it is malformed or escapes DIR.
function resolveSafePath(encoded) {
  let rel;
  try {
    rel = decodeURIComponent(encoded);
  } catch (err) {
    return null;
  }
  const abs = path.resolve(DIR, rel);
  if (!abs.startsWith(DIR + path.sep) || abs.endsWith(TEMP_SUFFIX)) return null;
  return abs;
}

function sendIndexHtml(res) {
  fs.readFile(path.join(__dirname, 'index.html'), (err, content) => {
    if (err) send(res, 404, 'File not found');
    else send(res, 200, content, 'text/html; charset=utf-8');
  });
}

async function listFiles(dir) {
  const out = [];
  for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await listFiles(abs));
    } else if (entry.isFile() && !entry.name.endsWith(TEMP_SUFFIX)) {
      const stat = await fs.promises.stat(abs);
      out.push({
        path: path.relative(DIR, abs).split(path.sep).join('/'),
        size: stat.size,
        mtime: stat.mtimeMs,
      });
    }
  }
  return out;
}

async function sendFileList(res) {
  try {
    const files = await listFiles(DIR);
    files.sort((a, b) => b.mtime - a.mtime);
    send(res, 200, JSON.stringify(files), 'application/json');
  } catch (err) {
    console.error(err);
    send(res, 500, 'Could not list files');
  }
}

function sendFile(encoded, res) {
  const file = resolveSafePath(encoded);
  if (!file) return send(res, 400, 'Invalid file name');
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return send(res, 404, 'File not found');
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': stat.size,
      'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(path.basename(file)),
    });
    pipeline(fs.createReadStream(file), res, (err) => {
      if (err) console.error('Download failed:', file, err.message);
    });
  });
}

// Streams the body to a temp file next to the target, then renames it,
// so an aborted upload never leaves a partial file or corrupts an existing one.
async function saveFile(encoded, req, res) {
  const file = resolveSafePath(encoded);
  if (!file) return send(res, 400, 'Invalid file name');
  const temp = file + '.' + process.pid + '.' + Date.now() + TEMP_SUFFIX;
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
  } catch (err) {
    return send(res, 500, 'Could not create folder');
  }
  pipeline(req, fs.createWriteStream(temp), (err) => {
    if (err) {
      fs.unlink(temp, () => {});
      console.error('Upload failed:', file, err.message);
      if (!res.headersSent) send(res, 500, 'Upload failed');
      return;
    }
    fs.rename(temp, file, (err) => {
      if (err) {
        fs.unlink(temp, () => {});
        return send(res, 500, 'Upload failed');
      }
      send(res, 200, 'Uploaded successfully');
    });
  });
}
