import assert from 'node:assert/strict';
import test from 'node:test';

import {
  handleAlexaEnvelope,
  validateCertificateUrl,
} from '../worker/src/alexa.js';
import worker from '../worker/src/index.js';
import { FamilyBoardObject } from '../worker/src/board-object.js';
import { emptyBoard } from '../worker/src/merge.js';
import { updateBoardWidget } from '../worker/src/widget.js';

const SKILL_ID = 'amzn1.ask.skill.family-board-test';
const OWNER = 'foxglove-lizard-donut-donut';
const VIEWER = 'bluejay-sequoia-pangolin-ruby';

class MemoryKv {
  constructor(entries = []) { this.values = new Map(entries); }
  async get(key) { return this.values.has(key) ? this.values.get(key) : null; }
  async put(key, value) { this.values.set(key, value); }
  async delete(key) { this.values.delete(key); }
}

class MemoryStorage {
  constructor() { this.values = new Map(); }
  async get(key) { return this.values.get(key); }
  async put(key, value) { this.values.set(key, value); }
  async transaction(run) { return run(this); }
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

function environment() {
  const board = emptyBoard('Our Family');
  board.chores.dishes = {
    title: 'Dishes',
    done: false,
    reward: 2,
    updatedAt: 1,
  };
  board.meals.today = {
    date: new Date().toISOString().slice(0, 10),
    meal: 'Tacos',
    updatedAt: 1,
  };
  const objects = new MemoryObjects();
  const boardId = `board:${OWNER}`;
  objects.storage(boardId).values.set('board', board);
  return {
    CODES: new MemoryKv([
      [`owner:${OWNER}`, boardId],
      [`share:${VIEWER}`, JSON.stringify({
        boardId,
        role: 'viewer',
        createdAt: 1,
      })],
    ]),
    BOARD_OBJECTS: objects,
    ALEXA_SKILL_ID: SKILL_ID,
  };
}

function envelope(intentName, slots = {}) {
  return {
    session: {
      application: { applicationId: SKILL_ID },
      user: { userId: 'amzn1.ask.account.family' },
    },
    context: {
      System: {
        application: { applicationId: SKILL_ID },
        user: { userId: 'amzn1.ask.account.family' },
        device: {
          supportedInterfaces: {
            'Alexa.Presentation.APL': {},
          },
        },
      },
    },
    request: {
      type: 'IntentRequest',
      timestamp: new Date().toISOString(),
      intent: {
        name: intentName,
        slots: Object.fromEntries(Object.entries(slots).map(([name, value]) => [
          name,
          { name, value },
        ])),
      },
    },
  };
}

function launch() {
  const result = envelope('AMAZON.HelpIntent');
  result.request = {
    type: 'LaunchRequest',
    timestamp: new Date().toISOString(),
  };
  return result;
}

function touch(action, id) {
  const result = launch();
  result.request = {
    type: 'Alexa.Presentation.APL.UserEvent',
    timestamp: new Date().toISOString(),
    arguments: [action, id],
  };
  return result;
}

test('Echo Show launches the linked family dashboard', async () => {
  const env = environment();
  await handleAlexaEnvelope(
    envelope('LinkBoardIntent', { boardCode: OWNER }),
    env,
  );
  const response = await handleAlexaEnvelope(launch(), env);
  assert.equal(
    response.response.directives[0].type,
    'Alexa.Presentation.APL.RenderDocument',
  );
  const data = response.response.directives[0].datasources.payload;
  assert.equal(data.title, 'Our Family');
  assert.equal(data.chores[0].title, 'Dishes');
  assert.equal(data.dinner, 'Tacos');
});

test('touch completes chores for owners and refuses viewers', async () => {
  const env = environment();
  await handleAlexaEnvelope(
    envelope('LinkBoardIntent', { boardCode: OWNER }),
    env,
  );
  const changed = await handleAlexaEnvelope(touch('toggleChore', 'dishes'), env);
  assert.equal(
    changed.response.directives[0].datasources.payload.chores[0].done,
    true,
  );

  await handleAlexaEnvelope(
    envelope('LinkBoardIntent', { boardCode: VIEWER }),
    env,
  );
  const refused = await handleAlexaEnvelope(touch('toggleChore', 'dishes'), env);
  assert.match(refused.response.outputSpeech.text, /only view/);
  assert.equal(
    refused.response.directives[0].datasources.payload.chores[0].done,
    true,
  );
});

test('Alexa HTTP endpoint refuses unsigned requests', async () => {
  const response = await worker.fetch(new Request(
    'https://worker.example/alexa',
    {
      method: 'POST',
      body: JSON.stringify(launch()),
    },
  ), environment());
  assert.equal(response.status, 401);
});

test('Alexa certificate URL accepts only the Amazon echo certificate path', () => {
  assert.equal(
    validateCertificateUrl(
      'https://s3.amazonaws.com/echo.api/echo-api-cert.pem',
    ).hostname,
    's3.amazonaws.com',
  );
  assert.throws(() => validateCertificateUrl(
    'https://example.com/echo.api/echo-api-cert.pem',
  ));
});

test('widget updates target the Alexa user with board summary only', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/auth/o2/token')) {
      return new Response(JSON.stringify({
        access_token: 'test-token',
        expires_in: 3600,
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ results: [{ type: 'SUCCESS' }] }));
  };
  try {
    const updated = await updateBoardWidget(
      launch(),
      {
        ALEXA_CLIENT_ID: 'client',
        ALEXA_CLIENT_SECRET: 'secret',
        ALEXA_DATASTORE_ENDPOINT: 'https://api.example',
      },
      {
        title: 'Our Family',
        events: [{ when: 'Today, 4 PM', title: 'Soccer' }],
        chores: [{ done: false }, { done: true }],
        dinner: 'Tacos',
      },
    );
    assert.equal(updated, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const body = JSON.parse(calls[1].options.body);
  assert.deepEqual(body.target, {
    type: 'USER',
    id: 'amzn1.ask.account.family',
  });
  assert.deepEqual(body.commands[0].content, {
    title: 'Our Family',
    next: 'Today, 4 PM: Soccer',
    chores: '1 chore left',
    dinner: 'Tacos',
  });
});
