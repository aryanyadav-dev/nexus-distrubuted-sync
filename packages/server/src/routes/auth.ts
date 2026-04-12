import { Router } from 'express';
import { z } from 'zod';
import { SignUpRequestSchema, SignInRequestSchema } from '@dsync/shared';
import { hashPassword, comparePassword, signToken } from '../auth/jwt';
import { createUser, findUserByEmail } from '../db/queries';
import { logger } from '../utils/logger';

const router = Router();

router.post('/signup', async (req, res) => {
  const parsed = SignUpRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }
  const { email, password, displayName } = parsed.data;

  try {
    const existing = await findUserByEmail(email);
    if (existing) {
      res.status(409).json({ ok: false, error: 'Email already registered' });
      return;
    }
    const passwordHash = await hashPassword(password);
    const user = await createUser(email, passwordHash, displayName);
    const token = signToken({ userId: user.id, email: user.email, displayName: user.displayName });
    logger.info('New user registered', { userId: user.id });
    res.status(201).json({ ok: true, data: { token, user } });
  } catch (err) {
    logger.error('Signup error', { error: (err as Error).message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

router.post('/signin', async (req, res) => {
  const parsed = SignInRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: 'Invalid request' });
    return;
  }
  const { email, password } = parsed.data;

  try {
    const user = await findUserByEmail(email);
    if (!user) {
      res.status(401).json({ ok: false, error: 'Invalid credentials' });
      return;
    }
    const valid = await comparePassword(password, user.passwordHash);
    if (!valid) {
      res.status(401).json({ ok: false, error: 'Invalid credentials' });
      return;
    }
    const token = signToken({ userId: user.id, email: user.email, displayName: user.displayName });
    logger.info('User signed in', { userId: user.id });
    res.json({ ok: true, data: { token, user: { id: user.id, email: user.email, displayName: user.displayName, createdAt: user.createdAt } } });
  } catch (err) {
    logger.error('Signin error', { error: (err as Error).message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

export default router;
