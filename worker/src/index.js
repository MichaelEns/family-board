import {
  allocateCode,
  canEdit,
  createShare,
  isOwner,
  listShares,
  ownerKey,
  resolveAccess,
  revokeShare,
} from './access.js';
import {
  createBoard,
  getBoard,
  mergeStoredBoard,
} from './board-store.js';
import { calendarEvents, validateCalendarUrl } from './calendar.js';
import { publicBoard } from './merge.js';
import { handleAlexaRequest } from './alexa.js';
export { FamilyBoardObject } from './board-object.js';

const MAX_BODY_BYTES = 1024 * 1024;

const json = (body, status = 200, extra = {}) => new Response(
  JSON.stringify(body),
  {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...extra,
    },
  },
);

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',')
    .map((item) => item.trim()).filter(Boolean);
  if (!origin || (allowed.length && !allowed.includes(origin))) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-Board-Code',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

async function limited(request, env) {
  if (!env.RATE_LIMITER) return false;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  return !(await env.RATE_LIMITER.limit({ key: ip })).success;
}

async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (path === '/' || path === '/health') {
    return json({ ok: true, service: 'family-board-sync' });
  }

  if (path === '/v1/new') {
    if (request.method !== 'POST') return json({ error: 'method' }, 405);
    const code = await allocateCode(env);
    if (!code) return json({ error: 'could not allocate code' }, 503);
    let body = {};
    try {
      const raw = await request.text();
      if (raw) body = JSON.parse(raw);
    } catch {
      return json({ error: 'not json' }, 400);
    }
    const { boardId, board } = await createBoard(env, code, body.name);
    await env.CODES.put(ownerKey(code), boardId);
    return json({ code, board: publicBoard(board, 'owner') }, 201);
  }

  const access = await resolveAccess(env, request.headers.get('X-Board-Code'));
  if (!access) return json({ error: 'invalid board code' }, 401);
  const board = await getBoard(env, access.boardId);

  if (path === '/v1/access' && request.method === 'GET') {
    return json({ name: board.name, role: access.role });
  }

  if (path === '/v1/board') {
    if (request.method === 'GET') {
      return json({ board: publicBoard(board, access.role) });
    }
    if (request.method !== 'POST') return json({ error: 'method' }, 405);
    if (!canEdit(access)) return json({ error: 'contributor access required' }, 403);
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return json({ error: 'too much' }, 413);
    let incoming;
    try { incoming = JSON.parse(raw); } catch { return json({ error: 'not json' }, 400); }
    if (access.role !== 'owner' && incoming && incoming.calendarFeeds) {
      incoming = { ...incoming };
      delete incoming.calendarFeeds;
    }
    const merged = await mergeStoredBoard(env, access.boardId, incoming);
    return json({ board: publicBoard(merged, access.role) });
  }

  if (path === '/v1/shares') {
    if (!isOwner(access)) return json({ error: 'owner access required' }, 403);
    if (request.method === 'GET') {
      return json({ shares: await listShares(env, access.boardId) });
    }
    if (request.method !== 'POST') return json({ error: 'method' }, 405);
    let body;
    try { body = JSON.parse(await request.text()); } catch {
      return json({ error: 'not json' }, 400);
    }
    const share = await createShare(env, access.boardId, body && body.role);
    return share
      ? json(share, 201)
      : json({ error: 'role must be viewer or contributor' }, 400);
  }

  const sharePath = /^\/v1\/shares\/([^/]+)$/.exec(path);
  if (sharePath) {
    if (!isOwner(access)) return json({ error: 'owner access required' }, 403);
    if (request.method !== 'DELETE') return json({ error: 'method' }, 405);
    return await revokeShare(
      env,
      access.boardId,
      decodeURIComponent(sharePath[1]),
    )
      ? json({ ok: true })
      : json({ error: 'no such share' }, 404);
  }

  if (path === '/v1/calendar-url' && request.method === 'POST') {
    if (!isOwner(access)) return json({ error: 'owner access required' }, 403);
    let body;
    try { body = JSON.parse(await request.text()); } catch {
      return json({ error: 'not json' }, 400);
    }
    const valid = validateCalendarUrl(body && body.url);
    return valid
      ? json({ ok: true, provider: valid.hostname })
      : json({ error: 'unsupported calendar URL' }, 400);
  }

  if (path === '/v1/events' && request.method === 'GET') {
    const from = new Date(url.searchParams.get('from') || Date.now());
    const to = new Date(url.searchParams.get('to') || Date.now() + 14 * 86400000);
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) ||
        to <= from || to - from > 62 * 86400000) {
      return json({ error: 'invalid event range' }, 400);
    }
    const remote = await calendarEvents(board, from, to);
    const local = Object.entries(board.events || {})
      .filter(([, event]) => {
        if (event.deleted) return false;
        const start = new Date(event.start);
        const end = new Date(event.end || event.start);
        return start < to && end >= from;
      })
      .map(([id, event]) => ({ id, ...event, sourceName: board.name }));
    return json({
      events: [...local, ...remote]
        .sort((left, right) => String(left.start).localeCompare(String(right.start))),
    });
  }

  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
    if (path === '/alexa') return handleAlexaRequest(request, env);

    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') {
      return cors
        ? new Response(null, { status: 204, headers: cors })
        : new Response(null, { status: 403 });
    }
    if (request.headers.get('Origin') && !cors) {
      return json({ error: 'not allowed from there' }, 403);
    }
    if (await limited(request, env)) {
      return json({ error: 'slow down' }, 429, cors || {});
    }
    try {
      const response = await handle(request, env);
      if (cors) {
        for (const [key, value] of Object.entries(cors)) {
          response.headers.set(key, value);
        }
      }
      return response;
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'worker failed');
      return json({ error: 'something broke' }, 500, cors || {});
    }
  },
};
