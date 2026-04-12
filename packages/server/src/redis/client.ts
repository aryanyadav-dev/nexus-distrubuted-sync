import Redis from 'ioredis';
import { logger } from '../utils/logger';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// Main client for commands
export const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  lazyConnect: true,
});

// Separate client for pub/sub (can't mix with commands)
export const redisSub = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  lazyConnect: true,
});

redis.on('error', (err) => logger.error('Redis error', { error: err.message }));
redisSub.on('error', (err) => logger.error('Redis sub error', { error: err.message }));

export async function connectRedis(): Promise<void> {
  await redis.connect();
  await redisSub.connect();
  logger.info('Redis connections established');
}

// ─────────────────────────────────────────────
// Presence helpers (TTL-based)
// ─────────────────────────────────────────────

const PRESENCE_TTL_SECONDS = 30; // expire after 30s without heartbeat

export async function setPresence(documentId: string, userId: string, displayName: string): Promise<void> {
  const key = `presence:${documentId}:${userId}`;
  await redis.setex(key, PRESENCE_TTL_SECONDS, JSON.stringify({ userId, displayName, ts: Date.now() }));
}

export async function refreshPresence(documentId: string, userId: string): Promise<void> {
  const key = `presence:${documentId}:${userId}`;
  await redis.expire(key, PRESENCE_TTL_SECONDS);
}

export async function removePresence(documentId: string, userId: string): Promise<void> {
  const key = `presence:${documentId}:${userId}`;
  await redis.del(key);
}

export async function getPresence(documentId: string): Promise<{ userId: string; displayName: string; ts: number }[]> {
  const keys = await redis.keys(`presence:${documentId}:*`);
  if (!keys.length) return [];
  const values = await redis.mget(...keys);
  return values
    .filter((v): v is string => v !== null)
    .map((v) => JSON.parse(v));
}

// ─────────────────────────────────────────────
// Pub/Sub channel helpers
// ─────────────────────────────────────────────

export function documentChannel(documentId: string): string {
  return `doc:${documentId}`;
}

export async function publishToDocument(documentId: string, message: unknown): Promise<void> {
  await redis.publish(documentChannel(documentId), JSON.stringify(message));
}
