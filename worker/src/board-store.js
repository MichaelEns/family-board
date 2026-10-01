function stub(env, boardId) {
  const id = env.BOARD_OBJECTS.idFromString(boardId);
  return env.BOARD_OBJECTS.get(id);
}

async function call(env, boardId, method, body) {
  const response = await stub(env, boardId).fetch(new Request('https://board.internal/board', {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `board object returned ${response.status}`);
  return result.board;
}

export async function createBoard(env, ownerCode, name) {
  const id = env.BOARD_OBJECTS.idFromName(ownerCode);
  const boardId = id.toString();
  const board = await call(env, boardId, 'PUT', { name });
  return { boardId, board };
}

export const getBoard = (env, boardId) => call(env, boardId, 'GET');
export const mergeStoredBoard = (env, boardId, incoming) =>
  call(env, boardId, 'POST', incoming);
