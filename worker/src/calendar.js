import ICAL from 'ical.js';

const MAX_CALENDAR_BYTES = 2 * 1024 * 1024;

function allowedHost(hostname) {
  const host = hostname.toLowerCase();
  return host === 'calendar.google.com' ||
    host === 'outlook.office365.com' ||
    host === 'outlook.live.com' ||
    /^p\d+-caldav\.icloud\.com$/.test(host);
}

export function validateCalendarUrl(raw) {
  let url;
  try {
    const value = String(raw || '').trim();
    url = new URL(
      value.toLowerCase().startsWith('webcal://')
        ? `https://${value.slice('webcal://'.length)}`
        : value,
    );
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password ||
      !allowedHost(url.hostname)) return null;
  return url;
}

async function fetchCalendar(rawUrl) {
  let url = validateCalendarUrl(rawUrl);
  if (!url) throw new Error('Calendar URL is not from a supported provider.');
  for (let redirect = 0; redirect < 3; redirect += 1) {
    const response = await fetch(url.href, { redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('Location');
      const next = location && validateCalendarUrl(new URL(location, url).href);
      if (!next) throw new Error('Calendar redirected outside supported providers.');
      url = next;
      continue;
    }
    if (!response.ok) throw new Error(`Calendar returned ${response.status}.`);
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_CALENDAR_BYTES) {
      throw new Error('Calendar is too large.');
    }
    return new TextDecoder().decode(bytes);
  }
  throw new Error('Calendar redirected too many times.');
}

function eventValue(event, start) {
  const end = event.endDate || start;
  return {
    id: event.uid || `${event.summary}-${start.toString()}`,
    title: event.summary || 'Untitled event',
    start: start.toJSDate().toISOString(),
    end: end.toJSDate().toISOString(),
    allDay: Boolean(start.isDate),
    location: event.location || '',
  };
}

export function parseCalendar(text, from, to) {
  const root = new ICAL.Component(ICAL.parse(text));
  const events = [];
  for (const component of root.getAllSubcomponents('vevent')) {
    const event = new ICAL.Event(component);
    if (!event.isRecurring()) {
      const start = event.startDate;
      if (start.toJSDate() < to && event.endDate.toJSDate() >= from) {
        events.push(eventValue(event, start));
      }
      continue;
    }
    const iterator = event.iterator();
    let next;
    let count = 0;
    while ((next = iterator.next()) && count < 5000) {
      const date = next.toJSDate();
      if (date >= to) break;
      if (event.getOccurrenceDetails(next).endDate.toJSDate() >= from) {
        const details = event.getOccurrenceDetails(next);
        events.push({
          ...eventValue(details.item, details.startDate),
          start: details.startDate.toJSDate().toISOString(),
          end: details.endDate.toJSDate().toISOString(),
          id: `${event.uid}:${details.startDate.toString()}`,
        });
      }
      count += 1;
    }
  }
  return events;
}

export async function calendarEvents(board, from, to) {
  const feeds = Object.entries(board.calendarFeeds || {})
    .filter(([, feed]) => !feed.deleted && feed.url);
  const results = await Promise.all(feeds.map(async ([feedId, feed]) => {
    try {
      const events = parseCalendar(await fetchCalendar(feed.url), from, to);
      return events.map((event) => ({
        ...event,
        sourceId: feedId,
        sourceName: feed.name,
        color: feed.color || '#5f7cff',
      }));
    } catch (error) {
      return [{
        id: `error:${feedId}`,
        sourceId: feedId,
        sourceName: feed.name,
        error: error instanceof Error ? error.message : 'Calendar unavailable.',
      }];
    }
  }));
  return results.flat();
}
