'use strict';

(function () {
  const ENDPOINT = 'https://family-board-sync.michaelens.workers.dev';
  const CODE_KEY = 'familyBoard.code';
  const $ = (id) => document.getElementById(id);
  const state = {
    code: localStorage.getItem(CODE_KEY) || '',
    board: null,
    events: [],
    role: '',
    tab: 'today',
  };
  let saveQueue = Promise.resolve();

  const nowIso = () => new Date().toISOString();
  const id = () => crypto.randomUUID();
  const snapshotKey = () => `familyBoard.snapshot.${state.code}`;
  const localInputValue = (date, includeTime = true) => {
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, includeTime ? 16 : 10);
  };

  function setStatus(message, bad = false) {
    $('status').textContent = message;
    $('status').style.color = bad ? '#ffc93d' : '';
  }

  async function api(path, { method = 'GET', body, code = state.code } = {}) {
    const response = await fetch(ENDPOINT + path, {
      method,
      headers: {
        ...(code ? { 'X-Board-Code': code } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || `Request returned ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  function remember() {
    if (!state.code || !state.board) return;
    localStorage.setItem(snapshotKey(), JSON.stringify(state.board));
  }

  function cachedBoard() {
    try { return JSON.parse(localStorage.getItem(snapshotKey()) || 'null'); } catch { return null; }
  }

  function live(map) {
    return Object.entries(map || {})
      .filter(([, item]) => item && !item.deleted)
      .map(([key, item]) => ({ id: key, ...item }));
  }

  function mergeSnapshot(remote, local) {
    if (!local) return remote;
    const merged = { ...remote };
    for (const section of [
      'profiles',
      'calendarFeeds',
      'events',
      'chores',
      'meals',
      'lists',
      'listItems',
    ]) {
      merged[section] = { ...(remote[section] || {}) };
      for (const [recordId, record] of Object.entries(local[section] || {})) {
        const received = merged[section][recordId];
        if (!received ||
            Number(record.updatedAt) > Number(received.updatedAt || 0)) {
          merged[section][recordId] = record;
        }
      }
    }
    return merged;
  }

  function profileName(profileId) {
    const profile = state.board && state.board.profiles &&
      state.board.profiles[profileId];
    return profile && !profile.deleted ? profile.name : '';
  }

  function activeTab(name) {
    state.tab = name;
    for (const tab of document.querySelectorAll('.tab')) {
      tab.hidden = tab.id !== `tab-${name}`;
    }
    for (const button of document.querySelectorAll('nav button')) {
      button.classList.toggle('active', button.dataset.tab === name);
    }
  }

  function renderEvents() {
    const list = $('events');
    list.innerHTML = '';
    const failures = state.events.filter((event) => event.error);
    const events = state.events.filter((event) => !event.error);
    if (!events.length) {
      const empty = document.createElement('li');
      empty.textContent = 'Nothing is scheduled in this range.';
      list.appendChild(empty);
    }
    for (const event of events) {
      const row = document.createElement('li');
      const time = document.createElement('time');
      const start = new Date(event.start);
      time.textContent = event.allDay
        ? start.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
        : start.toLocaleString([], {
          weekday: 'short', month: 'short', day: 'numeric',
          hour: 'numeric', minute: '2-digit',
        });
      const title = document.createElement('strong');
      title.textContent = event.title;
      const source = document.createElement('span');
      source.className = 'source';
      source.textContent = [event.sourceName, event.location].filter(Boolean).join(' · ');
      row.append(time, title, source);
      list.appendChild(row);
    }
    for (const failure of failures) {
      const row = document.createElement('li');
      row.textContent = `${failure.sourceName}: ${failure.error}`;
      list.appendChild(row);
    }
  }

  function renderChores() {
    const list = $('chores');
    list.innerHTML = '';
    for (const chore of live(state.board.chores)
      .sort((left, right) => Number(left.done) - Number(right.done))) {
      const row = document.createElement('li');
      const button = document.createElement('button');
      button.className = chore.done ? 'done' : '';
      button.textContent = `${chore.done ? '✓ ' : ''}${chore.title}`;
      button.disabled = state.role === 'viewer';
      button.addEventListener('click', () => patchRecord('chores', chore.id, {
        ...chore,
        done: !chore.done,
      }));
      const detail = document.createElement('span');
      detail.textContent = [
        profileName(chore.assigneeId),
        chore.reward ? `${chore.reward} ★` : '',
      ].filter(Boolean).join(' · ');
      row.append(button, detail);
      list.appendChild(row);
    }
  }

  function renderMeals() {
    const list = $('meals');
    list.innerHTML = '';
    const today = new Date();
    for (let offset = 0; offset < 7; offset += 1) {
      const date = new Date(today);
      date.setDate(today.getDate() + offset);
      const day = date.toISOString().slice(0, 10);
      const meal = live(state.board.meals).find((item) => item.date === day);
      const row = document.createElement('li');
      const label = document.createElement('strong');
      label.textContent = date.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
      const value = document.createElement('span');
      value.textContent = meal ? meal.meal : 'Not planned';
      row.append(label, value);
      list.appendChild(row);
    }
  }

  function renderLists() {
    const host = $('lists');
    host.innerHTML = '';
    for (const list of live(state.board.lists)) {
      const panel = document.createElement('section');
      panel.className = 'list-panel';
      const heading = document.createElement('h3');
      heading.textContent = list.name;
      const items = document.createElement('ul');
      for (const item of live(state.board.listItems)
        .filter((entry) => entry.listId === list.id)
        .sort((left, right) => Number(left.done) - Number(right.done))) {
        const row = document.createElement('li');
        const button = document.createElement('button');
        button.className = item.done ? 'done' : '';
        button.textContent = `${item.done ? '✓ ' : ''}${item.text}`;
        button.disabled = state.role === 'viewer';
        button.addEventListener('click', () => patchRecord('listItems', item.id, {
          ...item,
          done: !item.done,
        }));
        row.appendChild(button);
        items.appendChild(row);
      }
      const form = document.createElement('form');
      const input = document.createElement('input');
      input.placeholder = 'Add an item';
      input.required = true;
      const add = document.createElement('button');
      add.textContent = 'Add';
      form.append(input, add);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        patchRecord('listItems', id(), {
          listId: list.id,
          text: input.value,
          done: false,
        });
        input.value = '';
      });
      panel.append(heading, items);
      if (state.role !== 'viewer') panel.appendChild(form);
      host.appendChild(panel);
    }
  }

  function renderSettings() {
    $('access-role').textContent = state.role === 'owner'
      ? 'Owner access'
      : state.role === 'contributor' ? 'Contributor access' : 'View-only access';
    $('copy-code').textContent = state.code;
    document.body.classList.toggle('readonly', state.role === 'viewer');
    for (const item of document.querySelectorAll('.owner-only')) {
      item.hidden = state.role !== 'owner';
    }
    const people = live(state.board.profiles);
    $('chore-person').innerHTML = '';
    for (const person of people) {
      const option = document.createElement('option');
      option.value = person.id;
      option.textContent = person.name;
      $('chore-person').appendChild(option);
    }
    const feeds = $('calendar-feeds');
    feeds.innerHTML = '';
    for (const feed of live(state.board.calendarFeeds)) {
      const row = document.createElement('li');
      row.textContent = feed.name;
      feeds.appendChild(row);
    }
  }

  function render() {
    const connected = Boolean(state.code && state.board);
    $('onboarding').hidden = connected;
    $('board').hidden = !connected;
    if (!connected) return;
    $('board-title').textContent = state.board.name;
    renderEvents();
    renderChores();
    renderMeals();
    renderLists();
    renderSettings();
    activeTab(state.tab);
  }

  async function loadEvents() {
    if (!state.code) return;
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setDate(to.getDate() + 14);
    try {
      state.events = (await api(
        `/v1/events?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`,
      )).events || [];
      renderEvents();
    } catch (error) {
      setStatus(error.message, true);
    }
  }

  async function patchRecord(section, recordId, values) {
    if (state.role === 'viewer') return;
    const record = { ...values, updatedAt: Date.now() };
    state.board[section][recordId] = record;
    remember();
    render();
    const save = async () => {
      try {
        const result = await api('/v1/board', {
          method: 'POST',
          body: { [section]: { [recordId]: record } },
        });
        state.board = mergeSnapshot(result.board, state.board);
        state.role = result.board.role;
        remember();
        render();
        setStatus('Saved');
        if (section === 'events') await loadEvents();
      } catch (error) {
        setStatus('Saved on this device; waiting for a connection.', true);
      }
    };
    saveQueue = saveQueue.then(save, save);
    return saveQueue;
  }

  async function connect(code) {
    const normalized = String(code || '').toLowerCase().trim()
      .split(/[^a-z]+/).filter(Boolean).join('-');
    const access = await api('/v1/access', { code: normalized });
    state.code = normalized;
    state.role = access.role;
    localStorage.setItem(CODE_KEY, normalized);
    const cached = cachedBoard();
    const response = cached && access.role !== 'viewer'
      ? await api('/v1/board', { method: 'POST', body: cached })
      : await api('/v1/board');
    state.board = response.board;
    state.role = response.board.role;
    remember();
    render();
    await loadEvents();
  }

  async function createBoard() {
    const result = await api('/v1/new', {
      method: 'POST',
      code: '',
      body: { name: $('new-name').value },
    });
    state.code = result.code;
    state.board = result.board;
    state.role = 'owner';
    localStorage.setItem(CODE_KEY, result.code);
    remember();
    render();
    setStatus('Board created');
  }

  async function createShare() {
    const share = await api('/v1/shares', {
      method: 'POST',
      body: { role: $('share-role').value },
    });
    await navigator.clipboard.writeText(share.code).catch(() => {});
    window.alert(`${share.role} code:\n\n${share.code}\n\nIt has been copied when the browser allowed it.`);
    await loadShares();
  }

  async function loadShares() {
    if (state.role !== 'owner') return;
    const list = $('shares');
    list.innerHTML = '';
    for (const share of (await api('/v1/shares')).shares || []) {
      const row = document.createElement('li');
      const code = document.createElement('button');
      code.className = 'code';
      code.textContent = share.code;
      code.addEventListener('click', () => navigator.clipboard.writeText(share.code));
      const revoke = document.createElement('button');
      revoke.className = 'danger';
      revoke.textContent = 'Revoke';
      revoke.addEventListener('click', async () => {
        if (!confirm(`Revoke ${share.code}?`)) return;
        await api(`/v1/shares/${encodeURIComponent(share.code)}`, { method: 'DELETE' });
        await loadShares();
      });
      row.append(code, revoke);
      list.appendChild(row);
    }
  }

  function formRecord(formId, section, values) {
    $(formId).addEventListener('submit', (event) => {
      event.preventDefault();
      patchRecord(section, id(), values());
      event.target.reset();
    });
  }

  document.querySelector('nav').addEventListener('click', (event) => {
    if (event.target.dataset.tab) {
      activeTab(event.target.dataset.tab);
      if (event.target.dataset.tab === 'settings') loadShares().catch(() => {});
    }
  });
  $('create-board').addEventListener('click', () =>
    createBoard().catch((error) => setStatus(error.message, true)));
  $('join-board').addEventListener('click', () =>
    connect($('join-code').value).catch((error) => setStatus(error.message, true)));
  $('refresh-events').addEventListener('click', loadEvents);
  $('copy-code').addEventListener('click', () =>
    navigator.clipboard.writeText(state.code).catch(() => {}));
  $('disconnect').addEventListener('click', () => {
    if (!confirm('Disconnect this device? The shared board is not deleted.')) return;
    localStorage.removeItem(CODE_KEY);
    state.code = '';
    state.board = null;
    render();
  });
  $('create-share').addEventListener('click', () =>
    createShare().catch((error) => setStatus(error.message, true)));

  formRecord('profile-form', 'profiles', () => ({
    name: $('profile-name').value,
    color: $('profile-color').value,
  }));
  formRecord('chore-form', 'chores', () => ({
    title: $('chore-title').value,
    assigneeId: $('chore-person').value,
    reward: Number($('chore-reward').value) || 0,
    done: false,
    due: '',
  }));
  formRecord('meal-form', 'meals', () => ({
    date: $('meal-date').value,
    meal: $('meal-name').value,
  }));
  formRecord('list-form', 'lists', () => ({ name: $('list-name').value }));
  formRecord('event-form', 'events', () => ({
    title: $('event-title').value,
    start: new Date($('event-start').value).toISOString(),
    end: new Date($('event-end').value).toISOString(),
    allDay: false,
    profileId: '',
    location: '',
  }));

  $('calendar-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const url = $('calendar-url').value;
    try {
      await api('/v1/calendar-url', { method: 'POST', body: { url } });
      await patchRecord('calendarFeeds', id(), {
        name: $('calendar-name').value,
        color: '#5f7cff',
        url,
      });
      event.target.reset();
      await loadEvents();
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  const start = new Date();
  start.setMinutes(Math.ceil(start.getMinutes() / 30) * 30, 0, 0);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  $('event-start').value = localInputValue(start);
  $('event-end').value = localInputValue(end);
  $('meal-date').value = localInputValue(new Date(), false);

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/family-board/sw.js').catch(() => {});
    });
  }
  window.addEventListener('online', () => {
    if (state.code) {
      connect(state.code).catch((error) => setStatus(error.message, true));
    }
  });

  if (state.code) {
    connect(state.code).catch((error) => {
      state.board = cachedBoard();
      state.role = state.board && state.board.role || '';
      render();
      setStatus(`Offline: ${error.message}`, true);
    });
  } else {
    render();
  }
}());
