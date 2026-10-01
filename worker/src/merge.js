const SECTIONS = [
  'profiles',
  'calendarFeeds',
  'events',
  'chores',
  'meals',
  'lists',
  'listItems',
];

const LIMITS = {
  profiles: 20,
  calendarFeeds: 10,
  events: 1000,
  chores: 500,
  meals: 730,
  lists: 30,
  listItems: 1000,
};

function text(value, max) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, max);
}

function safeRecord(section, raw, now) {
  if (!raw || typeof raw !== 'object') return null;
  const updatedAt = Math.min(
    Math.max(0, Number(raw.updatedAt) || 0),
    now + 5 * 60 * 1000,
  );
  const common = { updatedAt, deleted: raw.deleted === true };
  if (common.deleted) return common;
  if (section === 'profiles') {
    return { ...common, name: text(raw.name, 50), color: text(raw.color, 20) };
  }
  if (section === 'calendarFeeds') {
    return {
      ...common,
      name: text(raw.name, 50),
      color: text(raw.color, 20),
      url: String(raw.url || '').trim().slice(0, 2048),
    };
  }
  if (section === 'events') {
    return {
      ...common,
      title: text(raw.title, 160),
      start: text(raw.start, 40),
      end: text(raw.end, 40),
      allDay: raw.allDay === true,
      profileId: text(raw.profileId, 80),
      location: text(raw.location, 120),
    };
  }
  if (section === 'chores') {
    return {
      ...common,
      title: text(raw.title, 160),
      assigneeId: text(raw.assigneeId, 80),
      due: text(raw.due, 40),
      reward: Math.max(0, Math.min(1000, Number(raw.reward) || 0)),
      done: raw.done === true,
    };
  }
  if (section === 'meals') {
    return {
      ...common,
      date: text(raw.date, 20),
      meal: text(raw.meal, 200),
    };
  }
  if (section === 'lists') {
    return { ...common, name: text(raw.name, 80) };
  }
  if (section === 'listItems') {
    return {
      ...common,
      listId: text(raw.listId, 80),
      text: text(raw.text, 200),
      done: raw.done === true,
    };
  }
  return null;
}

function mergeSection(section, stored, incoming, now) {
  const result = { ...(stored || {}) };
  let accepted = 0;
  for (const [id, raw] of Object.entries(incoming || {})) {
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) continue;
    if (accepted >= LIMITS[section]) break;
    const next = safeRecord(section, raw, now);
    if (!next) continue;
    const current = result[id];
    if (!current || next.updatedAt > (Number(current.updatedAt) || 0)) {
      result[id] = next;
    }
    accepted += 1;
  }
  return result;
}

export function emptyBoard(name = 'Family Board', now = Date.now()) {
  return {
    version: 1,
    name: text(name, 60) || 'Family Board',
    timezone: 'America/Los_Angeles',
    settingsUpdatedAt: now,
    profiles: {},
    calendarFeeds: {},
    events: {},
    chores: {},
    meals: {},
    lists: {},
    listItems: {},
  };
}

export function mergeBoard(stored, incoming, now = Date.now()) {
  const result = {
    ...emptyBoard(stored && stored.name, now),
    ...(stored || {}),
    version: 1,
  };
  const settingsAt = Math.min(
    Math.max(0, Number(incoming && incoming.settingsUpdatedAt) || 0),
    now + 5 * 60 * 1000,
  );
  if (settingsAt > (Number(result.settingsUpdatedAt) || 0)) {
    result.name = text(incoming.name, 60) || result.name;
    result.timezone = text(incoming.timezone, 80) || result.timezone;
    result.settingsUpdatedAt = settingsAt;
  }
  for (const section of SECTIONS) {
    result[section] = mergeSection(
      section,
      result[section],
      incoming && incoming[section],
      now,
    );
  }
  return result;
}

export function publicBoard(board, role) {
  const copy = structuredClone(board);
  if (role !== 'owner') {
    for (const feed of Object.values(copy.calendarFeeds || {})) {
      delete feed.url;
    }
  }
  return { ...copy, role };
}
