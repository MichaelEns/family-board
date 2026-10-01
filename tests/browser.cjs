'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const BROWSER = process.argv[2];
const ROOT = path.dirname(__dirname);
const SITE_PORT = 8815;
const API_PORT = 8816;
const CDP_PORT = 9315 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${SITE_PORT}/family-board/`;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

async function siteServer() {
  const server = http.createServer((req, res) => {
    const relative = decodeURIComponent(req.url.split('?')[0])
      .replace(/^\/family-board\/?/, '') || 'index.html';
    const file = path.join(ROOT, relative);
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) {
      res.writeHead(404); res.end(); return;
    }
    let bytes = fs.readFileSync(file);
    if (relative === 'app.js') {
      bytes = Buffer.from(String(bytes).replace(
        /const ENDPOINT = '[^']+'/,
        `const ENDPOINT = 'http://127.0.0.1:${API_PORT}'`,
      ));
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(bytes);
  });
  await new Promise((resolve) => server.listen(SITE_PORT, '127.0.0.1', resolve));
  return server;
}

async function apiServer() {
  const {
    default: worker,
    FamilyBoardObject,
  } = await import('../worker/src/index.js');
  const values = new Map();
  const objects = new Map();
  class MemoryStorage {
    constructor() { this.values = new Map(); }
    async get(key) { return this.values.get(key); }
    async put(key, value) { this.values.set(key, value); }
    async transaction(run) { return run(this); }
  }
  const namespace = {
    idFromName(name) { return { toString: () => `board:${name}` }; },
    idFromString(value) { return { toString: () => value }; },
    get(id) {
      const key = id.toString();
      if (!objects.has(key)) {
        const storage = new MemoryStorage();
        objects.set(key, new FamilyBoardObject({ storage }));
      }
      return objects.get(key);
    },
  };
  const env = {
    CODES: {
      async get(key) { return values.has(key) ? values.get(key) : null; },
      async put(key, value) { values.set(key, value); },
      async delete(key) { values.delete(key); },
    },
    BOARD_OBJECTS: namespace,
    ALLOWED_ORIGINS: `http://127.0.0.1:${SITE_PORT}`,
    RATE_LIMITER: { async limit() { return { success: true }; } },
  };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = new Request(`http://127.0.0.1:${API_PORT}${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: ['GET', 'HEAD'].includes(req.method)
        ? undefined
        : Buffer.concat(chunks),
    });
    const response = await worker.fetch(request, env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise((resolve) => server.listen(API_PORT, '127.0.0.1', resolve));
  return server;
}

const getJson = (route) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: CDP_PORT, path: route }, (res) => {
    let text = '';
    res.on('data', (chunk) => { text += chunk; });
    res.on('end', () => {
      try { resolve(JSON.parse(text)); } catch (error) { reject(error); }
    });
  }).on('error', reject);
});

async function main() {
  if (!BROWSER) throw new Error('usage: node tests/browser.cjs <edge path>');
  const site = await siteServer();
  const api = await apiServer();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'family-board-'));
  const browserProcess = spawn(BROWSER, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--disable-gpu',
    'about:blank',
  ], { stdio: 'ignore' });
  let ws;
  try {
    let targets;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try { targets = await getJson('/json/list'); break; } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    const target = targets.find((item) => item.type === 'page' && item.url === 'about:blank') ||
      targets.find((item) => item.type === 'page');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error('CDP connection failed'));
    });
    let nextId = 0;
    const rpc = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => reject(new Error(`timeout on ${method}`)), 30000);
      const onMessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.id !== id) return;
        clearTimeout(timer);
        ws.removeEventListener('message', onMessage);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
      };
      ws.addEventListener('message', onMessage);
      ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression) => {
      const result = await rpc('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description || 'browser exception');
      }
      return result.result.value;
    };
    const waitFor = async (expression, label) => {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        if (await evaluate(expression)) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`timed out waiting for ${label}`);
    };

    await rpc('Runtime.enable');
    await rpc('Page.enable');
    await rpc('Page.navigate', { url: BASE });
    await waitFor("document.getElementById('create-board')", 'onboarding');

    await evaluate(`(() => {
      document.getElementById('new-name').value = 'Our Family';
      document.getElementById('create-board').click();
    })()`);
    try {
      await waitFor("!document.getElementById('board').hidden", 'created board');
    } catch (error) {
      const detail = await evaluate(`JSON.stringify({
        status: document.getElementById('status').textContent,
        code: localStorage.getItem('familyBoard.code'),
        onboardingHidden: document.getElementById('onboarding').hidden,
      })`);
      throw new Error(`${error.message}: ${detail}`);
    }

    await evaluate(`(() => {
      document.querySelector('[data-tab=\"settings\"]').click();
      document.getElementById('profile-name').value = 'Joe';
      document.getElementById('profile-form').requestSubmit();
    })()`);
    await waitFor(
      "document.getElementById('chore-person').options.length === 1",
      'family member',
    );

    await evaluate(`(() => {
      document.querySelector('[data-tab=\"chores\"]').click();
      document.getElementById('chore-title').value = 'Put toys away';
      document.getElementById('chore-reward').value = '3';
      document.getElementById('chore-form').requestSubmit();
    })()`);
    await waitFor(
      "document.getElementById('chores').textContent.includes('Put toys away')",
      'chore',
    );

    await evaluate(`(() => {
      document.querySelector('[data-tab=\"meals\"]').click();
      document.getElementById('meal-date').value = new Date().toISOString().slice(0, 10);
      document.getElementById('meal-name').value = 'Tacos';
      document.getElementById('meal-form').requestSubmit();
    })()`);
    await waitFor(
      "localStorage.getItem('familyBoard.snapshot.' + localStorage.getItem('familyBoard.code')).includes('Tacos')",
      'meal persistence',
    );
    await waitFor(
      "document.getElementById('meals').textContent.includes('Tacos')",
      'meal',
    );

    await evaluate(`(() => {
      document.querySelector('[data-tab=\"lists\"]').click();
      document.getElementById('list-name').value = 'Groceries';
      document.getElementById('list-form').requestSubmit();
    })()`);
    await waitFor(
      "document.getElementById('lists').textContent.includes('Groceries')",
      'list',
    );

    await evaluate(`(() => {
      document.querySelector('[data-tab=\"today\"]').click();
      document.getElementById('event-title').value = 'Dentist';
      document.getElementById('event-form').requestSubmit();
    })()`);
    await waitFor(
      "localStorage.getItem('familyBoard.snapshot.' + localStorage.getItem('familyBoard.code')).includes('Dentist')",
      'local event persistence',
    );
    await evaluate("document.getElementById('refresh-events').click()");
    await waitFor(
      "document.getElementById('events').textContent.includes('Dentist')",
      'local event',
    );

    const before = await evaluate(`JSON.stringify({
      title: document.getElementById('board-title').textContent,
      code: localStorage.getItem('familyBoard.code'),
      snapshot: Boolean(localStorage.getItem(
        'familyBoard.snapshot.' + localStorage.getItem('familyBoard.code'))),
    })`);
    const parsed = JSON.parse(before);
    if (parsed.title !== 'Our Family' ||
        !/^[a-z]+-[a-z]+-[a-z]+-[a-z]+$/.test(parsed.code) ||
        !parsed.snapshot) {
      throw new Error(`unexpected persisted board: ${before}`);
    }

    await rpc('Page.reload', { ignoreCache: true });
    await waitFor(
      "!document.getElementById('board').hidden && document.getElementById('board-title').textContent === 'Our Family'",
      'board after reload',
    );
    console.log('FAMILY BOARD BROWSER VERIFIED ✅');
  } finally {
    try { if (ws) ws.close(); } catch {}
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(browserProcess.pid), '/T', '/F'], {
          stdio: 'ignore',
        });
      } else {
        browserProcess.kill();
      }
    } catch {}
    await new Promise((resolve) => site.close(resolve));
    await new Promise((resolve) => api.close(resolve));
    setTimeout(() => {
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
    }, 500);
  }
}

main().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
