import { emptyBoard, mergeBoard } from './merge.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
});

export class FamilyBoardObject {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path !== '/board') return json({ error: 'not found' }, 404);

    if (request.method === 'GET') {
      const board = await this.state.storage.get('board');
      return board ? json({ board }) : json({ error: 'board not initialized' }, 404);
    }

    if (request.method === 'PUT') {
      let incoming;
      try { incoming = await request.json(); } catch {
        return json({ error: 'not json' }, 400);
      }
      let board;
      await this.state.storage.transaction(async (transaction) => {
        board = await transaction.get('board');
        if (!board) {
          board = emptyBoard(incoming && incoming.name);
          await transaction.put('board', board);
        }
      });
      return json({ board });
    }

    if (request.method === 'POST') {
      let incoming;
      try { incoming = await request.json(); } catch {
        return json({ error: 'not json' }, 400);
      }
      let board;
      await this.state.storage.transaction(async (transaction) => {
        const stored = await transaction.get('board');
        if (!stored) throw new Error('board not initialized');
        board = mergeBoard(stored, incoming, Date.now());
        await transaction.put('board', board);
      });
      return json({ board });
    }

    return json({ error: 'method' }, 405);
  }
}
