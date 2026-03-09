const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const dgram = require('dgram');
const { XMLParser } = require('fast-xml-parser');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

app.use(cors());
app.use(express.json());

// ─── Non-playable device models (hidden from rooms, shown in settings) ────────
const NON_PLAYABLE_MODELS = [
  'Sonos Bridge', 'Sonos Sub', 'Sonos Sub Mini',
  'Sub', 'Bridge', 'Boost'
];

function isPlayable(device) {
  if (!device) return false;
  const model = (device.model || '').toLowerCase();
  return !NON_PLAYABLE_MODELS.some(m => model.includes(m.toLowerCase()));
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, 'config.json');

function loadConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch(e) {}
  }
  const cfg = { username: 'admin', passwordHash: crypto.createHash('sha256').update('sonos').digest('hex') };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  return cfg;
}

const sessions = new Map();
function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { expires: Date.now() + 30 * 24 * 60 * 60 * 1000 });
  return token;
}
function isValidSession(token) {
  if (!token) return false;
  const s = sessions.get(token);
  if (!s) return false;
  if (Date.now() > s.expires) { sessions.delete(token); return false; }
  return true;
}
function getToken(req) {
  const h = req.headers['x-auth-token'];
  if (h && isValidSession(h)) return h;
  const c = req.headers.cookie;
  if (c) { const m = c.match(/sonos_token=([^;]+)/); if (m && isValidSession(m[1])) return m[1]; }
  return null;
}

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const cfg = loadConfig();
  const hash = crypto.createHash('sha256').update(password || '').digest('hex');
  if (username === cfg.username && hash === cfg.passwordHash) {
    const token = createSession();
    res.cookie('sonos_token', token, { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
    res.json({ ok: true, token });
  } else {
    res.status(401).json({ error: 'Invalid username or password' });
  }
});

app.post('/api/logout', (req, res) => {
  const token = getToken(req);
  if (token) sessions.delete(token);
  res.clearCookie('sonos_token');
  res.json({ ok: true });
});

app.get('/api/auth/check', (req, res) => {
  res.json({ authenticated: !!getToken(req) });
});

function requireAuth(req, res, next) {
  if (req.path === '/api/login') return next();
  if (getToken(req)) return next();
  if (req.headers.accept?.includes('text/html')) return res.sendFile(path.join(__dirname, '../frontend/public/index.html'));
  res.status(401).json({ error: 'Unauthorised' });
}

app.use(requireAuth);
app.use(express.static(path.join(__dirname, '../frontend/public')));

// ─── Device storage ───────────────────────────────────────────────────────────
// All devices including non-playable (for settings)
let allDevices = {};
// Group topology: coordinatorHost -> [memberHost, ...]
let groupTopology = {};

// ─── UPnP/SSDP Discovery ─────────────────────────────────────────────────────
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

function discoverDevices() {
  const SSDP_ADDR = '239.255.255.250', SSDP_PORT = 1900;
  const msg = Buffer.from([
    'M-SEARCH * HTTP/1.1',
    `HOST: ${SSDP_ADDR}:${SSDP_PORT}`,
    'MAN: "ssdp:discover"',
    'MX: 3',
    'ST: urn:schemas-upnp-org:device:ZonePlayer:1',
    '', ''
  ].join('\r\n'));

  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  socket.bind(0, '0.0.0.0', () => {
    try {
      socket.setBroadcast(true);
      try { socket.addMembership(SSDP_ADDR); } catch(e) {}
      socket.send(msg, 0, msg.length, SSDP_PORT, SSDP_ADDR);
    } catch(e) { console.error('SSDP send error:', e.message); }

    socket.on('message', async (data, rinfo) => {
      const str = data.toString();
      if (!str.includes('Sonos') && !str.includes('ZonePlayer')) return;
      const locMatch = str.match(/LOCATION:\s*(http:\/\/[^\r\n]+)/i);
      if (!locMatch) return;
      try { await fetchDeviceDescription(locMatch[1], rinfo.address); } catch(e) {}
    });

    setTimeout(() => {
      try { socket.close(); } catch(e) {}
      const playable = Object.values(allDevices).filter(isPlayable);
      if (playable.length === 0) {
        console.log('No playable Sonos devices found');
        io.emit('demoMode', true);
      } else {
        io.emit('demoMode', false);
        refreshGroupTopology();
      }
      emitDevices();
    }, 8000);
  });
  socket.on('error', (e) => { console.error('SSDP error:', e.message); });
}

async function fetchDeviceDescription(url, host) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: 4000 }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const parsed = parser.parse(data);
          const dev = parsed?.root?.device;
          if (!dev) return reject(new Error('No device info'));
          const port = parseInt(new URL(url).port || '1400');
          const model = dev.modelName || dev.modelNumber || 'Sonos';
          const info = {
            host,
            port,
            name: dev.roomName || dev.friendlyName || host,
            model,
            udn: (dev.UDN || host).replace('uuid:', ''),
            playable: !NON_PLAYABLE_MODELS.some(m => model.toLowerCase().includes(m.toLowerCase())),
            groupCoordinator: null,
            groupMembers: []
          };
          if (!allDevices[host]) {
            allDevices[host] = info;
            console.log(`Discovered: ${info.name} (${info.model}) @ ${host}${info.playable ? '' : ' [non-playable]'}`);
            emitDevices();
          }
          resolve(info);
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function emitDevices() {
  // Send all devices to frontend (frontend decides what to show where)
  io.emit('devices', Object.values(allDevices));
}

// ─── Group topology ───────────────────────────────────────────────────────────
async function refreshGroupTopology() {
  // Use any playable device to get topology
  const anyDevice = Object.values(allDevices).find(isPlayable);
  if (!anyDevice) return;
  try {
    const groups = await getGroups(anyDevice.host, anyDevice.port);
    // Reset group info on all devices
    Object.values(allDevices).forEach(d => { d.groupCoordinator = null; d.groupMembers = []; });
    groupTopology = {};

    for (const g of groups) {
      // Find coordinator device
      const coordDevice = Object.values(allDevices).find(d => d.udn === g.coordinator);
      if (!coordDevice) continue;
      const coordHost = coordDevice.host;
      const memberHosts = g.members
        .map(m => Object.values(allDevices).find(d => d.udn === m.uuid)?.host)
        .filter(Boolean);

      groupTopology[coordHost] = memberHosts;

      // Update each member
      memberHosts.forEach(h => {
        if (allDevices[h]) {
          allDevices[h].groupCoordinator = coordHost;
          if (allDevices[coordHost]) {
            allDevices[coordHost].groupMembers = memberHosts.filter(mh => mh !== coordHost);
          }
        }
      });
    }
    emitDevices();
    io.emit('groupTopology', groupTopology);
  } catch(e) { console.error('Group topology error:', e.message); }
}

// ─── SOAP helper ──────────────────────────────────────────────────────────────
function soapRequest(host, port, service, action, body = '') {
  return new Promise((resolve, reject) => {
    const serviceMap = {
      AVTransport:       { path: '/MediaRenderer/AVTransport/Control',     urn: 'urn:schemas-upnp-org:service:AVTransport:1' },
      RenderingControl:  { path: '/MediaRenderer/RenderingControl/Control', urn: 'urn:schemas-upnp-org:service:RenderingControl:1' },
      ContentDirectory:  { path: '/MediaServer/ContentDirectory/Control',   urn: 'urn:schemas-upnp-org:service:ContentDirectory:1' },
      ZoneGroupTopology: { path: '/ZoneGroupTopology/Control',              urn: 'urn:schemas-upnp-org:service:ZoneGroupTopology:1' },
    };
    const svc = serviceMap[service];
    if (!svc) return reject(new Error('Unknown service: ' + service));
    const envelope = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body><u:${action} xmlns:u="${svc.urn}">${body}</u:${action}></s:Body>
</s:Envelope>`;
    const opts = {
      hostname: host, port: parseInt(port) || 1400,
      path: svc.path, method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': `"${svc.urn}#${action}"`,
        'Content-Length': Buffer.byteLength(envelope)
      },
      timeout: 6000
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          const fault = xmlVal(data, 'faultstring') || xmlVal(data, 'errorDescription') || `HTTP ${res.statusCode}`;
          return reject(new Error(fault));
        }
        resolve(data);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('SOAP timeout')); });
    req.write(envelope);
    req.end();
  });
}

function xmlVal(data, tag) {
  // Use a non-greedy match that stops at any opening tag to prevent bleed-through
  const m = data.match(new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i'))
    || data.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  if (!m) return null;
  return m[1]
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'")
    .trim();
}

// ─── State helpers ────────────────────────────────────────────────────────────
async function getFullState(host, port) {
  const [transportData, posData, volData, muteData] = await Promise.all([
    soapRequest(host, port, 'AVTransport', 'GetTransportInfo', '<InstanceID>0</InstanceID>').catch(() => ''),
    soapRequest(host, port, 'AVTransport', 'GetPositionInfo', '<InstanceID>0</InstanceID>').catch(() => ''),
    soapRequest(host, port, 'RenderingControl', 'GetVolume', '<InstanceID>0</InstanceID><Channel>Master</Channel>').catch(() => ''),
    soapRequest(host, port, 'RenderingControl', 'GetMute', '<InstanceID>0</InstanceID><Channel>Master</Channel>').catch(() => '')
  ]);

  const playing = (xmlVal(transportData, 'CurrentTransportState') || '').toUpperCase() === 'PLAYING';
  const volume = parseInt(xmlVal(volData, 'CurrentVolume') || '0');
  const muted = xmlVal(muteData, 'CurrentMute') === '1';
  const metadata = xmlVal(posData, 'TrackMetaData') || '';
  const duration = xmlVal(posData, 'TrackDuration') || '';
  const position = xmlVal(posData, 'RelTime') || '';

  // Parse track metadata — metadata is HTML-encoded XML, decode it first
  let title = '', artist = '', album = '', albumArtUri = '';
  if (metadata) {
    // Decode the double-encoded XML
    const decoded = metadata
      .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
      .replace(/&quot;/g,'"').replace(/&#39;/g,"'");
    title = xmlVal(decoded, 'dc:title') || '';
    artist = xmlVal(decoded, 'dc:creator') || xmlVal(decoded, 'r:albumArtist') || '';
    album = xmlVal(decoded, 'upnp:album') || '';
    // Extract albumArtURI — get only the URL, stop at any tag
    const rawArt = (decoded.match(/<upnp:albumArtURI[^>]*>([^<]+)/i) || [])[1] || '';
    if (rawArt && rawArt.trim()) {
      const artUrl = rawArt.trim().startsWith('http') ? rawArt.trim() : `http://${host}:${port}${rawArt.trim().startsWith('/') ? '' : '/'}${rawArt.trim()}`;
      albumArtUri = `/api/art?url=${encodeURIComponent(artUrl)}`;
    }
  }

  // Strip raw URIs that leaked through as titles
  if (title && (title.startsWith('x-') || title.startsWith('http') || title.includes('://'))) {
    title = '';
  }
  // For radio with no title, don't show the raw URI
  if (!title && playing) {
    title = 'Live Radio';
  }

  return {
    playing, volume, muted,
    track: { title, artist, album, albumArtUri, duration, position }
  };
}

async function getGroups(host, port) {
  const data = await soapRequest(host, port, 'ZoneGroupTopology', 'GetZoneGroupState', '');
  const stateXml = xmlVal(data, 'ZoneGroupState') || '';
  const groups = [];
  const groupMatches = stateXml.matchAll(/<ZoneGroup\s+Coordinator="([^"]+)"[^>]*>([\s\S]*?)<\/ZoneGroup>/g);
  for (const m of groupMatches) {
    const memberMatches = [...m[2].matchAll(/UUID="([^"]+)"[^>]*Location="([^"]+)"[^>]*ZoneName="([^"]+)"/g)];
    groups.push({
      coordinator: m[1],
      members: memberMatches.map(mm => ({ uuid: mm[1], location: mm[2], name: mm[3] }))
    });
  }
  return groups;
}

async function getFavorites(host, port) {
  const data = await soapRequest(host, port, 'ContentDirectory', 'Browse',
    '<ObjectID>FV:2</ObjectID><BrowseFlag>BrowseDirectChildren</BrowseFlag><Filter>*</Filter><StartingIndex>0</StartingIndex><RequestedCount>50</RequestedCount><SortCriteria></SortCriteria>');
  const result = xmlVal(data, 'Result') || '';
  // Decode the outer HTML encoding to get the inner DIDL XML
  const decoded = result
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"').replace(/&#39;/g,"'");
  const items = [];
  for (const m of decoded.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/g)) {
    const inner = m[1];
    const title = xmlVal(inner, 'dc:title') || 'Untitled';
    const uri = xmlVal(inner, 'res') || '';
    // r:resMD is the metadata Sonos needs — extract and re-encode for SOAP
    const resMD = xmlVal(inner, 'r:resMD') || '';
    const metadata = resMD
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    const rawArt = (inner.match(/<upnp:albumArtURI[^>]*>([^<]+)/i) || [])[1] || '';
    const artUrl = rawArt.trim() ? (rawArt.trim().startsWith('http') ? rawArt.trim() : `http://${host}:${port}${rawArt.trim().startsWith('/')?'':'/'}${rawArt.trim()}`) : '';
    items.push({
      title,
      uri,
      metadata,
      albumArtUri: artUrl ? `/api/art?url=${encodeURIComponent(artUrl)}` : ''
    });
  }
  return items;
}

async function getQueue(host, port) {
  const data = await soapRequest(host, port, 'ContentDirectory', 'Browse',
    '<ObjectID>Q:0</ObjectID><BrowseFlag>BrowseDirectChildren</BrowseFlag><Filter>*</Filter><StartingIndex>0</StartingIndex><RequestedCount>50</RequestedCount><SortCriteria></SortCriteria>');
  const result = xmlVal(data, 'Result') || '';
  const items = [];
  for (const m of result.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/g)) {
    const rawArt = xmlVal(m[1], 'upnp:albumArtURI') || '';
    const artUrl = rawArt ? (rawArt.startsWith('http') ? rawArt : `http://${host}:${port}${rawArt.startsWith('/')?'':'/'}${rawArt}`) : '';
    items.push({
      title: xmlVal(m[1], 'dc:title') || 'Unknown',
      artist: xmlVal(m[1], 'dc:creator') || '',
      album: xmlVal(m[1], 'upnp:album') || '',
      duration: xmlVal(m[1], 'res@duration') || '',
      albumArtUri: artUrl ? `/api/art?url=${encodeURIComponent(artUrl)}` : ''
    });
  }
  return items;
}

// ─── Album art proxy (follows redirects) ─────────────────────────────────────
function proxyArt(url, res, redirects = 0) {
  if (redirects > 5) return res.status(404).end();
  try {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? require('https') : http;
    const defaultPort = parsed.protocol === 'https:' ? '443' : '1400';
    const req = mod.get({
      hostname: parsed.hostname,
      port: parseInt(parsed.port || defaultPort),
      path: parsed.pathname + (parsed.search || ''),
      timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Connection': 'close', 'Accept': 'image/*' }
    }, (proxyRes) => {
      // Follow redirects
      if ([301,302,303,307,308].includes(proxyRes.statusCode) && proxyRes.headers.location) {
        const location = proxyRes.headers.location;
        const redirectUrl = location.startsWith('http') ? location : new URL(location, url).href;
        proxyRes.resume();
        return proxyArt(redirectUrl, res, redirects + 1);
      }
      const ct = proxyRes.headers['content-type'] || 'image/jpeg';
      if (!ct.startsWith('image/')) { proxyRes.resume(); return res.status(404).end(); }
      res.setHeader('Content-Type', ct);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      proxyRes.pipe(res);
    });
    req.on('error', () => res.status(404).end());
    req.on('timeout', () => { req.destroy(); res.status(504).end(); });
  } catch(e) { res.status(400).end(); }
}

app.get('/api/art', (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).end();
  res.setTimeout(25000, () => res.status(504).end());
  proxyArt(url, res);
});

// ─── REST API ─────────────────────────────────────────────────────────────────
app.get('/api/devices', (req, res) => res.json(Object.values(allDevices)));

app.post('/api/rediscover', (req, res) => {
  allDevices = {}; groupTopology = {};
  io.emit('devices', []);
  discoverDevices();
  res.json({ ok: true });
});

function getHostPort(host) {
  const dev = allDevices[host];
  return { host, port: dev?.port || 1400 };
}

app.get('/api/device/:host/state', async (req, res) => {
  const { host, port } = getHostPort(req.params.host);
  try {
    const state = await getFullState(host, port);
    const queue = await getQueue(host, port).catch(() => []);
    res.json({ ...state, queue });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Route playback commands to group coordinator if this device is a member
function getCoordinatorHostPort(host) {
  const dev = allDevices[host];
  const port = dev?.port || 1400;
  // Check if this host is a non-coordinator member of a group
  for (const [coordHost, members] of Object.entries(groupTopology)) {
    if (coordHost !== host && members.includes(host)) {
      const coordDev = allDevices[coordHost];
      return { host: coordHost, port: coordDev?.port || 1400 };
    }
  }
  return { host, port };
}

app.post('/api/device/:host/play', async (req, res) => {
  const { host, port } = getCoordinatorHostPort(req.params.host);
  try { await soapRequest(host, port, 'AVTransport', 'Play', '<InstanceID>0</InstanceID><Speed>1</Speed>'); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/device/:host/pause', async (req, res) => {
  const { host, port } = getCoordinatorHostPort(req.params.host);
  try { await soapRequest(host, port, 'AVTransport', 'Pause', '<InstanceID>0</InstanceID>'); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/device/:host/next', async (req, res) => {
  const { host, port } = getCoordinatorHostPort(req.params.host);
  try { await soapRequest(host, port, 'AVTransport', 'Next', '<InstanceID>0</InstanceID>'); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/device/:host/previous', async (req, res) => {
  const { host, port } = getCoordinatorHostPort(req.params.host);
  try { await soapRequest(host, port, 'AVTransport', 'Previous', '<InstanceID>0</InstanceID>'); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/device/:host/volume', async (req, res) => {
  const { host, port } = getHostPort(req.params.host);
  const vol = Math.max(0, Math.min(100, parseInt(req.body.volume)));
  try { await soapRequest(host, port, 'RenderingControl', 'SetVolume', `<InstanceID>0</InstanceID><Channel>Master</Channel><DesiredVolume>${vol}</DesiredVolume>`); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/device/:host/mute', async (req, res) => {
  const { host, port } = getHostPort(req.params.host);
  try { await soapRequest(host, port, 'RenderingControl', 'SetMute', `<InstanceID>0</InstanceID><Channel>Master</Channel><DesiredMute>${req.body.muted ? '1' : '0'}</DesiredMute>`); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/device/:host/seek', async (req, res) => {
  const { host, port } = getHostPort(req.params.host);
  const p = req.body.position;
  const ts = `${String(Math.floor(p/3600)).padStart(2,'0')}:${String(Math.floor((p%3600)/60)).padStart(2,'0')}:${String(p%60).padStart(2,'0')}`;
  try { await soapRequest(host, port, 'AVTransport', 'Seek', `<InstanceID>0</InstanceID><Unit>REL_TIME</Unit><Target>${ts}</Target>`); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/device/:host/shuffle', async (req, res) => {
  const { host, port } = getHostPort(req.params.host);
  try {
    const d = await soapRequest(host, port, 'AVTransport', 'GetTransportSettings', '<InstanceID>0</InstanceID>');
    const mode = xmlVal(d, 'PlayMode') || 'NORMAL';
    const repeatOn = mode.includes('REPEAT');
    const newMode = req.body.enabled ? (repeatOn ? 'SHUFFLE' : 'SHUFFLE_NOREPEAT') : (repeatOn ? 'REPEAT_ALL' : 'NORMAL');
    await soapRequest(host, port, 'AVTransport', 'SetPlayMode', `<InstanceID>0</InstanceID><NewPlayMode>${newMode}</NewPlayMode>`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/device/:host/repeat', async (req, res) => {
  const { host, port } = getHostPort(req.params.host);
  try {
    const d = await soapRequest(host, port, 'AVTransport', 'GetTransportSettings', '<InstanceID>0</InstanceID>');
    const shuffleOn = (xmlVal(d, 'PlayMode') || '').includes('SHUFFLE');
    const modeMap = { none: shuffleOn ? 'SHUFFLE_NOREPEAT' : 'NORMAL', all: shuffleOn ? 'SHUFFLE' : 'REPEAT_ALL', one: 'REPEAT_ONE' };
    await soapRequest(host, port, 'AVTransport', 'SetPlayMode', `<InstanceID>0</InstanceID><NewPlayMode>${modeMap[req.body.mode] || 'NORMAL'}</NewPlayMode>`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/device/:host/playUri', async (req, res) => {
  const { host, port } = getCoordinatorHostPort(req.params.host);
  const { uri, metadata = '' } = req.body;
  try {
    await soapRequest(host, port, 'AVTransport', 'SetAVTransportURI', `<InstanceID>0</InstanceID><CurrentURI>${uri}</CurrentURI><CurrentURIMetaData>${metadata}</CurrentURIMetaData>`);
    await soapRequest(host, port, 'AVTransport', 'Play', '<InstanceID>0</InstanceID><Speed>1</Speed>');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/device/:host/queue', async (req, res) => {
  const { host, port } = getHostPort(req.params.host);
  try { await soapRequest(host, port, 'AVTransport', 'RemoveAllTracksFromQueue', '<InstanceID>0</InstanceID>'); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/device/:host/queue', async (req, res) => {
  const { host, port } = getHostPort(req.params.host);
  try { res.json({ items: await getQueue(host, port) }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/device/:host/favorites', async (req, res) => {
  const { host, port } = getHostPort(req.params.host);
  try { res.json({ items: await getFavorites(host, port) }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/device/:host/groups', async (req, res) => {
  const { host, port } = getHostPort(req.params.host);
  try { res.json({ groups: await getGroups(host, port) }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/device/:host/join', async (req, res) => {
  const { host, port } = getHostPort(req.params.host);
  const coordHost = req.body.coordinator;
  const coord = allDevices[coordHost];
  if (!coord) return res.status(404).json({ error: 'Coordinator not found' });
  const rincon = `x-rincon:RINCON_${coord.udn.replace(/-/g,'').toUpperCase()}01400`;
  try {
    await soapRequest(host, port, 'AVTransport', 'SetAVTransportURI', `<InstanceID>0</InstanceID><CurrentURI>${rincon}</CurrentURI><CurrentURIMetaData></CurrentURIMetaData>`);
    await refreshGroupTopology();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/device/:host/leave', async (req, res) => {
  const { host, port } = getHostPort(req.params.host);
  try {
    await soapRequest(host, port, 'AVTransport', 'BecomeCoordinatorOfStandaloneGroup', '<InstanceID>0</InstanceID>');
    await refreshGroupTopology();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Search: local library + TuneIn radio ────────────────────────────────────
async function searchMusicLibrary(host, port, query) {
  try {
    const data = await soapRequest(host, port, 'ContentDirectory', 'Browse',
      `<ObjectID>A:</ObjectID><BrowseFlag>BrowseDirectChildren</BrowseFlag><Filter>*</Filter><StartingIndex>0</StartingIndex><RequestedCount>0</RequestedCount><SortCriteria></SortCriteria>`);
    // Try tracks search
    const searchData = await soapRequest(host, port, 'ContentDirectory', 'Search',
      `<ContainerID>A:TRACKS</ContainerID><SearchCriteria>dc:title contains "${query}"</SearchCriteria><Filter>*</Filter><StartingIndex>0</StartingIndex><RequestedCount>20</RequestedCount><SortCriteria></SortCriteria>`).catch(() => null);
    if (!searchData) return [];
    const result = xmlVal(searchData, 'Result') || '';
    const items = [];
    for (const m of result.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/g)) {
      const rawArt = xmlVal(m[1], 'upnp:albumArtURI') || '';
      const artUrl = rawArt ? (rawArt.startsWith('http') ? rawArt : `http://${host}:${port}${rawArt.startsWith('/')?'':'/'}${rawArt}`) : '';
      items.push({
        type: 'track',
        title: xmlVal(m[1], 'dc:title') || 'Unknown',
        artist: xmlVal(m[1], 'dc:creator') || '',
        album: xmlVal(m[1], 'upnp:album') || '',
        uri: xmlVal(m[1], 'res') || '',
        albumArtUri: artUrl ? `/api/art?url=${encodeURIComponent(artUrl)}` : ''
      });
    }
    return items;
  } catch(e) { return []; }
}

async function searchTuneIn(query) {
  return new Promise((resolve) => {
    const path = `/Search.ashx?query=${encodeURIComponent(query)}&formats=ogg,aac,mp3&render=json`;
    const req = https.get({
      hostname: 'opml.radiotime.com',
      path,
      timeout: 8000,
      headers: { 'User-Agent': 'Sonos/1.0' }
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const items = [];
          const body = json.body || [];
          for (const item of body) {
            if (item.type === 'audio' || item.element === 'outline') {
              items.push({
                type: 'radio',
                title: item.text || item.name || 'Unknown Station',
                artist: item.subtext || '',
                uri: item.URL || '',
                albumArtUri: item.image ? `/api/art?url=${encodeURIComponent(item.image)}` : '',
                tuneInId: item.guide_id || ''
              });
            }
          }
          resolve(items.slice(0, 15));
        } catch(e) { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
  });
}

app.get('/api/device/:host/search', async (req, res) => {
  const { host, port } = getHostPort(req.params.host);
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ items: [] });
  try {
    const [local, radio] = await Promise.all([
      searchMusicLibrary(host, port, q),
      searchTuneIn(q)
    ]);
    res.json({ items: [...local, ...radio] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// For radio: resolve TuneIn URL to actual stream then play
app.post('/api/device/:host/playTuneIn', async (req, res) => {
  const { host, port } = getHostPort(req.params.host);
  const { uri, title } = req.body;
  if (!uri) return res.status(400).json({ error: 'No URI' });
  try {
    // Fetch the actual stream URL from TuneIn
    const streamUrl = await new Promise((resolve, reject) => {
      const req2 = https.get(uri + '&render=json', { timeout: 8000 }, (r) => {
        let d = ''; r.on('data', c => d += c);
        r.on('end', () => {
          try {
            const json = JSON.parse(d);
            const stream = (json.body || []).find(i => i.url || i.URL);
            resolve(stream ? (stream.url || stream.URL) : null);
          } catch(e) { reject(e); }
        });
      });
      req2.on('error', reject);
      req2.on('timeout', () => { req2.destroy(); reject(new Error('timeout')); });
    });
    const playUri = streamUrl || uri;
    await soapRequest(host, port, 'AVTransport', 'SetAVTransportURI',
      `<InstanceID>0</InstanceID><CurrentURI>${playUri}</CurrentURI><CurrentURIMetaData></CurrentURIMetaData>`);
    await soapRequest(host, port, 'AVTransport', 'Play', '<InstanceID>0</InstanceID><Speed>1</Speed>');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../frontend/public/index.html')));

// ─── Polling ──────────────────────────────────────────────────────────────────
async function pollStates() {
  // Only poll playable devices
  for (const dev of Object.values(allDevices).filter(isPlayable)) {
    try {
      const state = await getFullState(dev.host, dev.port);
      io.emit('stateUpdate', { host: dev.host, state });
    } catch(e) { /* speaker may be offline or sleeping */ }
  }
}

io.on('connection', (socket) => {
  console.log('Client connected');
  socket.emit('devices', Object.values(allDevices));
  socket.emit('groupTopology', groupTopology);
  const hasPlayable = Object.values(allDevices).some(isPlayable);
  socket.emit('demoMode', !hasPlayable);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Sonos Online running on port ${PORT}`);
  loadConfig();
  discoverDevices();
  setInterval(discoverDevices, 120000);
  setInterval(pollStates, 3000);
  // Refresh group topology every 30 seconds
  setInterval(refreshGroupTopology, 30000);
});
