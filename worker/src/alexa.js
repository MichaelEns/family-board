import 'reflect-metadata';
import {
  SubjectAlternativeNameExtension,
  X509Certificate,
  cryptoProvider,
} from '@peculiar/x509';
import dashboardDocument from '../../alexa/apl/dashboard.json' with { type: 'json' };
import { canEdit, resolveAccess } from './access.js';
import { getBoard, mergeStoredBoard } from './board-store.js';
import { calendarEvents } from './calendar.js';
import { updateBoardWidget } from './widget.js';

const CERTIFICATE_HOST = 's3.amazonaws.com';
const CERTIFICATE_PATH = '/echo.api/';
const REQUEST_MAX_AGE_MS = 150 * 1000;
const MAX_REQUEST_BYTES = 100 * 1024;
const certificateCache = new Map();

class AlexaRequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function base64Bytes(value) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

export function validateCertificateUrl(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch {
    throw new AlexaRequestError(401, 'Invalid Alexa certificate URL.');
  }
  if (url.protocol !== 'https:' || url.hostname !== CERTIFICATE_HOST ||
      (url.port && url.port !== '443') ||
      !url.pathname.startsWith(CERTIFICATE_PATH) ||
      url.username || url.password || url.search || url.hash) {
    throw new AlexaRequestError(401, 'Untrusted Alexa certificate URL.');
  }
  return url;
}

async function certificateFor(rawUrl) {
  const url = validateCertificateUrl(rawUrl);
  const cached = certificateCache.get(url.href);
  if (cached && cached.expiresAt > Date.now()) return cached.certificate;
  const response = await fetch(url.href, { redirect: 'manual' });
  if (!response.ok) throw new AlexaRequestError(401, 'Alexa certificate could not be loaded.');
  const match = (await response.text()).match(
    /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/,
  );
  if (!match) throw new AlexaRequestError(401, 'Alexa certificate was invalid.');
  cryptoProvider.set(globalThis.crypto);
  const certificate = new X509Certificate(match[0]);
  const now = Date.now();
  if (certificate.notBefore.getTime() > now || certificate.notAfter.getTime() < now) {
    throw new AlexaRequestError(401, 'Alexa certificate was expired.');
  }
  const san = certificate.getExtension(SubjectAlternativeNameExtension);
  if (!san || !san.names.items.some(
    (name) => name.type === 'dns' && name.value === 'echo-api.amazon.com',
  )) {
    throw new AlexaRequestError(401, 'Alexa certificate identity was invalid.');
  }
  certificateCache.set(url.href, {
    certificate,
    expiresAt: Math.min(certificate.notAfter.getTime(), now + 6 * 3600000),
  });
  return certificate;
}

async function verifyAlexaRequest(request, rawBody, envelope, expectedSkillId) {
  const certificateUrl = request.headers.get('SignatureCertChainUrl');
  const signature = request.headers.get('Signature');
  if (!certificateUrl || !signature) {
    throw new AlexaRequestError(401, 'Alexa signature headers were missing.');
  }
  const certificate = await certificateFor(certificateUrl);
  const publicKey = await certificate.publicKey.export({
    name: 'RSASSA-PKCS1-v1_5',
    hash: 'SHA-1',
  }, ['verify'], globalThis.crypto);
  const valid = await crypto.subtle.verify(
    { name: 'RSASSA-PKCS1-v1_5' },
    publicKey,
    base64Bytes(signature),
    new TextEncoder().encode(rawBody),
  );
  if (!valid) throw new AlexaRequestError(401, 'Alexa signature was invalid.');
  const timestamp = Date.parse(envelope.request && envelope.request.timestamp);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > REQUEST_MAX_AGE_MS) {
    throw new AlexaRequestError(400, 'Alexa timestamp was invalid.');
  }
  const applicationId = envelope.context && envelope.context.System &&
    envelope.context.System.application &&
    envelope.context.System.application.applicationId ||
    envelope.session && envelope.session.application &&
    envelope.session.application.applicationId;
  if (!expectedSkillId || applicationId !== expectedSkillId) {
    throw new AlexaRequestError(403, 'Alexa skill ID did not match.');
  }
}

function rawSlot(envelope, name) {
  const slots = envelope.request && envelope.request.intent &&
    envelope.request.intent.slots || {};
  return slots[name] && slots[name].value;
}

function userId(envelope) {
  return envelope.context && envelope.context.System &&
    envelope.context.System.user && envelope.context.System.user.userId ||
    envelope.session && envelope.session.user && envelope.session.user.userId;
}

async function userKey(envelope) {
  const id = userId(envelope);
  if (!id) throw new Error('Alexa user ID was missing.');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id));
  return 'alexa-user:' + [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function emptyLinks() {
  return { version: 1, activeCode: '', boards: [] };
}

async function linksFor(envelope, env) {
  const raw = await env.CODES.get(await userKey(envelope));
  if (!raw) return emptyLinks();
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === 1 && Array.isArray(parsed.boards)) return parsed;
  } catch { /* no legacy format exists */ }
  return emptyLinks();
}

async function saveLinks(envelope, env, links) {
  await env.CODES.put(await userKey(envelope), JSON.stringify(links));
}

async function boardFor(envelope, env) {
  const links = await linksFor(envelope, env);
  const selected = links.boards.find((item) => item.code === links.activeCode) ||
    links.boards[0];
  if (!selected) return { links, access: null, board: null };
  const access = await resolveAccess(env, selected.code);
  if (!access) throw new Error('The selected board code no longer works.');
  const board = await getBoard(env, access.boardId);
  return { links, access, board };
}

function response(speech, directives = [], reprompt) {
  const result = {
    version: '1.0',
    response: {
      outputSpeech: { type: 'PlainText', text: speech },
      shouldEndSession: !reprompt && !directives.length,
    },
  };
  if (directives.length) result.response.directives = directives;
  if (reprompt) {
    result.response.reprompt = { outputSpeech: { type: 'PlainText', text: reprompt } };
  }
  return result;
}

function supportsApl(envelope) {
  const interfaces = envelope.context && envelope.context.System &&
    envelope.context.System.device &&
    envelope.context.System.device.supportedInterfaces;
  return Boolean(interfaces && interfaces['Alexa.Presentation.APL']);
}

function localEvents(board, from, to) {
  return Object.entries(board.events || {}).filter(([, event]) => {
    if (event.deleted) return false;
    const start = new Date(event.start);
    const end = new Date(event.end || event.start);
    return start < to && end >= from;
  }).map(([id, event]) => ({ id, ...event, sourceName: board.name }));
}

async function dashboardData(board, access) {
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setDate(to.getDate() + 7);
  const remote = await calendarEvents(board, from, to);
  const events = [...localEvents(board, from, to), ...remote]
    .filter((event) => !event.error)
    .sort((left, right) => String(left.start).localeCompare(String(right.start)))
    .slice(0, 12)
    .map((event) => ({
      title: event.title,
      when: new Date(event.start).toLocaleString('en-US', {
        weekday: 'short', hour: 'numeric', minute: '2-digit',
        timeZone: board.timezone,
      }),
    }));
  const chores = Object.entries(board.chores || {})
    .filter(([, chore]) => !chore.deleted)
    .map(([id, chore]) => ({
      id,
      title: chore.title,
      done: chore.done,
      rewardText: chore.reward ? `${chore.reward} ★` : '',
    }))
    .sort((left, right) => Number(left.done) - Number(right.done))
    .slice(0, 10);
  const date = new Date().toISOString().slice(0, 10);
  const dinner = Object.values(board.meals || {})
    .find((meal) => !meal.deleted && meal.date === date);
  return {
    title: board.name,
    subtitle: access.role === 'viewer' ? 'View only' : 'Tap a chore to complete it',
    canEdit: canEdit(access),
    events,
    chores,
    dinner: dinner ? dinner.meal : 'Not planned yet',
  };
}

async function dashboardDirective(board, access) {
  return {
    type: 'Alexa.Presentation.APL.RenderDocument',
    token: 'family-board-dashboard',
    document: dashboardDocument,
    datasources: { payload: await dashboardData(board, access) },
  };
}

async function refreshWidget(envelope, env, board, access) {
  try {
    await updateBoardWidget(envelope, env, await dashboardData(board, access));
  } catch (error) {
    console.warn(`Family Board widget refresh failed: ${error.message}`);
  }
}

async function toggleChore(env, access, board, choreId) {
  if (!canEdit(access)) return board;
  const chore = board.chores && board.chores[choreId];
  if (!chore || chore.deleted) return board;
  const merged = await mergeStoredBoard(env, access.boardId, {
    chores: {
      [choreId]: { ...chore, done: !chore.done, updatedAt: Date.now() },
    },
  });
  return merged;
}

export async function handleAlexaEnvelope(envelope, env) {
  const request = envelope.request || {};
  try {
    if (request.type === 'LaunchRequest') {
      const selected = await boardFor(envelope, env);
      if (!selected.board) {
        return response(
          'First connect a Family Board. Say, use board code, followed by the four words.',
          [],
          'What is the board code?',
        );
      }
      await refreshWidget(envelope, env, selected.board, selected.access);
      return response(
        `${selected.board.name} is open.`,
        supportsApl(envelope)
          ? [await dashboardDirective(selected.board, selected.access)]
          : [],
      );
    }

    if (request.type === 'Alexa.Presentation.APL.UserEvent') {
      const selected = await boardFor(envelope, env);
      if (!selected.board) return response('Connect a board first.');
      const [action, recordId] = request.arguments || [];
      let board = selected.board;
      if (action === 'toggleChore') {
        board = await toggleChore(env, selected.access, board, recordId);
      }
      await refreshWidget(envelope, env, board, selected.access);
      return response(
        selected.access.role === 'viewer' && action === 'toggleChore'
          ? 'This sharing code can only view the board.'
          : 'Updated.',
        [await dashboardDirective(board, selected.access)],
      );
    }

    if (request.type === 'Alexa.DataStore.PackageManager.UsagesInstalled' ||
        request.type === 'Alexa.DataStore.PackageManager.UpdateRequest') {
      const selected = await boardFor(envelope, env);
      if (selected.board) {
        await refreshWidget(envelope, env, selected.board, selected.access);
      }
      return { version: '1.0', response: {} };
    }
    if (request.type.startsWith('Alexa.DataStore.')) {
      return { version: '1.0', response: {} };
    }
    if (request.type === 'SessionEndedRequest') return { version: '1.0', response: {} };
    if (request.type !== 'IntentRequest') return response('I did not understand that.');

    const intent = request.intent && request.intent.name;
    if (intent === 'LinkBoardIntent') {
      const code = String(rawSlot(envelope, 'boardCode') || '').toLowerCase()
        .split(/[^a-z]+/).filter(Boolean).join('-');
      const access = await resolveAccess(env, code);
      if (!access) return response('That board code was not recognized.');
      const board = await getBoard(env, access.boardId);
      const links = await linksFor(envelope, env);
      const existing = links.boards.find((item) => item.code === code);
      if (existing) existing.name = board.name;
      else links.boards.push({ code, name: board.name });
      links.activeCode = code;
      await saveLinks(envelope, env, links);
      await refreshWidget(envelope, env, board, access);
      return response(`${board.name} is connected and selected.`);
    }
    if (intent === 'ListBoardsIntent') {
      const links = await linksFor(envelope, env);
      return response(links.boards.length
        ? `The connected boards are ${links.boards.map((item) => item.name).join(', ')}.`
        : 'No Family Board is connected.');
    }
    if (intent === 'SelectBoardIntent') {
      const wanted = String(rawSlot(envelope, 'boardName') || '').toLowerCase();
      const links = await linksFor(envelope, env);
      const matches = links.boards.filter((item) =>
        item.name.toLowerCase().includes(wanted) ||
        wanted.includes(item.name.toLowerCase()));
      if (matches.length !== 1) return response('I could not find exactly one board by that name.');
      links.activeCode = matches[0].code;
      await saveLinks(envelope, env, links);
      const selected = await boardFor(envelope, env);
      await refreshWidget(envelope, env, selected.board, selected.access);
      return response(`${matches[0].name} is selected.`);
    }
    if (intent === 'UnlinkBoardIntent') {
      const links = await linksFor(envelope, env);
      const selected = links.boards.find((item) => item.code === links.activeCode) ||
        links.boards[0];
      if (!selected) return response('No board is connected.');
      links.boards = links.boards.filter((item) => item.code !== selected.code);
      links.activeCode = links.boards[0] ? links.boards[0].code : '';
      if (links.boards.length) await saveLinks(envelope, env, links);
      else await env.CODES.delete(await userKey(envelope));
      return response(`${selected.name} is disconnected.`);
    }
    if (intent === 'UnlinkAllBoardsIntent') {
      await env.CODES.delete(await userKey(envelope));
      return response('All Family Boards are disconnected.');
    }
    if (intent === 'AMAZON.HelpIntent') {
      return response(
        'Say open Family Board, list my boards, or switch to a board name.',
        [],
        'What would you like to do?',
      );
    }
    if (intent === 'AMAZON.StopIntent' || intent === 'AMAZON.CancelIntent') {
      return response('Goodbye.');
    }
    return response('I did not understand that Family Board request.');
  } catch (error) {
    console.error(`Family Board Alexa request failed: ${error.message}`);
    return response('I could not reach Family Board just now.');
  }
}

export async function handleAlexaRequest(request, env) {
  if (request.method !== 'POST') return new Response('Method not allowed.', { status: 405 });
  const rawBody = await request.text();
  if (!rawBody || rawBody.length > MAX_REQUEST_BYTES) {
    return new Response('Invalid request body.', { status: 400 });
  }
  let envelope;
  try { envelope = JSON.parse(rawBody); } catch {
    return new Response('Invalid JSON.', { status: 400 });
  }
  try {
    await verifyAlexaRequest(request, rawBody, envelope, env.ALEXA_SKILL_ID);
  } catch (error) {
    const status = error instanceof AlexaRequestError ? error.status : 401;
    return new Response('Unauthorized Alexa request.', { status });
  }
  return new Response(JSON.stringify(await handleAlexaEnvelope(envelope, env)), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
