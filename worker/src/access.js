import { makeCode, normaliseCode } from './code.js';

export const ownerKey = (code) => `owner:${code}`;
const shareKey = (code) => `share:${code}`;
const shareIndexKey = (code) => `shares:${code}`;
const ROLES = new Set(['viewer', 'contributor']);

function parse(raw, fallback) {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : fallback;
  } catch {
    return fallback;
  }
}

export async function allocateCode(env) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = makeCode();
    const [board, share] = await Promise.all([
      env.CODES.get(ownerKey(code)),
      env.CODES.get(shareKey(code)),
    ]);
    if (board === null && share === null) return code;
  }
  return null;
}

export async function resolveAccess(env, rawCode) {
  const credentialCode = normaliseCode(rawCode);
  if (!credentialCode) return null;
  const boardId = await env.CODES.get(ownerKey(credentialCode));
  if (boardId !== null) {
    return {
      credentialCode,
      boardId,
      role: 'owner',
    };
  }
  const share = parse(await env.CODES.get(shareKey(credentialCode)), null);
  if (!share || !ROLES.has(share.role)) return null;
  return {
    credentialCode,
    boardId: share.boardId,
    role: share.role,
  };
}

async function readShareIndex(env, boardId) {
  return parse(await env.CODES.get(shareIndexKey(boardId)), {});
}

export async function createShare(env, boardId, role) {
  if (!ROLES.has(role)) return null;
  const code = await allocateCode(env);
  if (!code) return null;
  const entry = { boardId, role, createdAt: Date.now() };
  const index = await readShareIndex(env, boardId);
  index[code] = { role, createdAt: entry.createdAt };
  await env.CODES.put(shareKey(code), JSON.stringify(entry));
  await env.CODES.put(shareIndexKey(boardId), JSON.stringify(index));
  return { code, role, createdAt: entry.createdAt };
}

export async function listShares(env, boardId) {
  const index = await readShareIndex(env, boardId);
  return Object.entries(index).map(([code, entry]) => ({
    code,
    role: entry.role,
    createdAt: entry.createdAt,
  }));
}

export async function revokeShare(env, boardId, rawCode) {
  const code = normaliseCode(rawCode);
  if (!code) return false;
  const share = parse(await env.CODES.get(shareKey(code)), null);
  if (!share || share.boardId !== boardId) return false;
  await env.CODES.delete(shareKey(code));
  const index = await readShareIndex(env, boardId);
  delete index[code];
  await env.CODES.put(shareIndexKey(boardId), JSON.stringify(index));
  return true;
}

export const canEdit = (access) =>
  access && (access.role === 'owner' || access.role === 'contributor');
export const isOwner = (access) => access && access.role === 'owner';
