import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCalendar, validateCalendarUrl } from '../worker/src/calendar.js';
import { FamilyBoardObject } from '../worker/src/board-object.js';
import { emptyBoard, mergeBoard } from '../worker/src/merge.js';
import worker from '../worker/src/index.js';

const OWNER = 'foxglove-lizard-donut-donut';

class MemoryKv {
  constructor(entries = []) { this.values = new Map(entries); }
  async get(key) { return this.values.has(key) ? this.values.get(key) : null; }
  async put(key, value) { this.values.set(key, value); }
  async delete(key) { this.values.delete(key); }
}

class MemoryStorage {
  constructor() {
    this.values = new Map();
    this.queue = Promise.resolve();
  }
  async get(key) { return this.values.get(key); }
  async put(key, value) { this.values.set(key, value); }
  async transaction(run) {
    const result = this.queue.then(() => run(this));
    this.queue = result.catch(() => {});
    return result;
  }
}

class MemoryObjects {
  constructor() { this.objects = new Map(); }
  idFromName(name) { return { toString: () => `board:${name}` }; }
  idFromString(value) { return { toString: () => value }; }
  get(id) {
    const key = id.toString();
    if (!this.objects.has(key)) {
      const storage = new MemoryStorage();
      this.objects.set(key, {
        storage,
        object: new FamilyBoardObject({ storage }),
      });
    }
    return this.objects.get(key).object;
  }
  storage(value) {
    this.get(this.idFromString(value));
    return this.objects.get(value).storage;
  }
}

function env(board = emptyBoard('Our Family')) {
  const objects = new MemoryObjects();
  const boardId = `board:${OWNER}`;
  objects.storage(boardId).values.set('board', board);
  return {
    CODES: new MemoryKv([[`owner:${OWNER}`, boardId]]),
    BOARD_OBJECTS: objects,
    RATE_LIMITER: { async limit() { return { success: true }; } },
  };
}

function request(path, {
  method = 'GET',
  code = OWNER,
  body,
} = {}) {
  return new Request(`https://worker.example${path}`, {
    method,
    headers: {
      ...(code ? { 'X-Board-Code': code } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function makeShare(environment, role) {
  const response = await worker.fetch(request('/v1/shares', {
    method: 'POST',
    body: { role },
  }), environment);
  assert.equal(response.status, 201);
  return response.json();
}

test('per-record merge preserves concurrent household edits', () => {
  const stored = emptyBoard('Our Family', 1);
  stored.chores.a = { title: 'Dishes', done: false, updatedAt: 10 };
  const merged = mergeBoard(stored, {
    chores: {
      b: { title: 'Toys', done: false, updatedAt: 11 },
    },
    meals: {
      monday: { date: '2026-09-30', meal: 'Tacos', updatedAt: 12 },
    },
  }, 20);
  assert.equal(merged.chores.a.title, 'Dishes');
  assert.equal(merged.chores.b.title, 'Toys');
  assert.equal(merged.meals.monday.meal, 'Tacos');
});

test('the board object serializes simultaneous edits from two homes', async () => {
  const environment = env();
  const send = (id, title) => worker.fetch(request('/v1/board', {
    method: 'POST',
    body: {
      chores: {
        [id]: { title, done: false, updatedAt: Date.now() },
      },
    },
  }), environment);
  const [first, second] = await Promise.all([
    send('home-a', 'Dishes'),
    send('home-b', 'Toys'),
  ]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const board = await (await worker.fetch(request('/v1/board'), environment)).json();
  assert.equal(board.board.chores['home-a'].title, 'Dishes');
  assert.equal(board.board.chores['home-b'].title, 'Toys');
});

test('viewer and contributor codes enforce their roles', async () => {
  const environment = env();
  const contributor = await makeShare(environment, 'contributor');
  const viewer = await makeShare(environment, 'viewer');

  const update = await worker.fetch(request('/v1/board', {
    method: 'POST',
    code: contributor.code,
    body: {
      chores: {
        dishes: { title: 'Dishes', done: false, updatedAt: 10 },
      },
    },
  }), environment);
  assert.equal(update.status, 200);
  assert.equal((await update.json()).board.chores.dishes.title, 'Dishes');

  const blocked = await worker.fetch(request('/v1/board', {
    method: 'POST',
    code: viewer.code,
    body: {
      chores: {
        dishes: { title: 'Changed', done: true, updatedAt: 20 },
      },
    },
  }), environment);
  assert.equal(blocked.status, 403);
});

test('calendar feed secrets are visible only to the board owner', async () => {
  const board = emptyBoard('Our Family');
  board.calendarFeeds.school = {
    name: 'School',
    url: 'https://calendar.google.com/calendar/ical/private/basic.ics',
    updatedAt: 1,
  };
  const environment = env(board);
  const share = await makeShare(environment, 'contributor');

  const owner = await worker.fetch(request('/v1/board'), environment);
  assert.match((await owner.json()).board.calendarFeeds.school.url, /^https:/);

  const shared = await worker.fetch(request('/v1/board', {
    code: share.code,
  }), environment);
  assert.equal((await shared.json()).board.calendarFeeds.school.url, undefined);
});

test('calendar URLs are restricted to supported HTTPS providers', () => {
  assert.equal(
    validateCalendarUrl(
      'https://calendar.google.com/calendar/ical/private/basic.ics',
    ).hostname,
    'calendar.google.com',
  );
  assert.equal(
    validateCalendarUrl(
      'webcal://p42-caldav.icloud.com/published/2/example',
    ).protocol,
    'https:',
  );
  assert.equal(validateCalendarUrl('https://127.0.0.1/private.ics'), null);
  assert.equal(validateCalendarUrl('http://calendar.google.com/basic.ics'), null);
});

test('calendar parser expands recurring events only inside the requested range', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:school',
    'DTSTART:20260928T160000Z',
    'DTEND:20260928T170000Z',
    'RRULE:FREQ=WEEKLY;COUNT=4',
    'SUMMARY:Soccer',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const events = parseCalendar(
    ics,
    new Date('2026-09-29T00:00:00Z'),
    new Date('2026-10-20T00:00:00Z'),
  );
  assert.deepEqual(
    events.map((event) => event.start),
    [
      '2026-10-05T16:00:00.000Z',
      '2026-10-12T16:00:00.000Z',
      '2026-10-19T16:00:00.000Z',
    ],
  );
});

test('local board events are returned without a calendar provider', async () => {
  const board = emptyBoard('Our Family');
  board.events.dentist = {
    title: 'Dentist',
    start: '2026-10-01T17:00:00.000Z',
    end: '2026-10-01T18:00:00.000Z',
    updatedAt: 1,
  };
  const environment = env(board);
  const response = await worker.fetch(request(
    '/v1/events?from=2026-10-01T00%3A00%3A00Z&to=2026-10-02T00%3A00%3A00Z',
  ), environment);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).events[0].title, 'Dentist');
});
