let cachedToken = null;

async function token(env) {
  if (!env.ALEXA_CLIENT_ID || !env.ALEXA_CLIENT_SECRET) return null;
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60000) {
    return cachedToken.value;
  }
  const response = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env.ALEXA_CLIENT_ID,
      client_secret: env.ALEXA_CLIENT_SECRET,
      scope: 'alexa::datastore',
    }),
  });
  if (!response.ok) throw new Error(`token request returned ${response.status}`);
  const body = await response.json();
  cachedToken = {
    value: body.access_token,
    expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000,
  };
  return cachedToken.value;
}

function userId(envelope) {
  return envelope.context && envelope.context.System &&
    envelope.context.System.user && envelope.context.System.user.userId ||
    envelope.session && envelope.session.user && envelope.session.user.userId;
}

export async function updateBoardWidget(envelope, env, dashboard) {
  const accessToken = await token(env);
  const user = userId(envelope);
  if (!accessToken || !user) return false;
  const nextEvent = dashboard.events[0];
  const openChores = dashboard.chores.filter((chore) => !chore.done).length;
  const content = {
    title: dashboard.title,
    next: nextEvent ? `${nextEvent.when}: ${nextEvent.title}` : 'Nothing coming up',
    chores: `${openChores} chore${openChores === 1 ? '' : 's'} left`,
    dinner: dashboard.dinner,
  };
  const endpoint = env.ALEXA_DATASTORE_ENDPOINT || 'https://api.amazonalexa.com';
  const response = await fetch(`${endpoint}/v1/datastore/commands`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      commands: [{
        type: 'PUT_OBJECT',
        namespace: 'FamilyBoard',
        key: 'summary',
        content,
      }],
      target: { type: 'USER', id: user },
    }),
  });
  if (!response.ok) throw new Error(`widget update returned ${response.status}`);
  return true;
}
