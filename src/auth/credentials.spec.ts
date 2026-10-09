import {
  createRefreshToken,
  hashSecret,
  parseRefreshToken,
  pinSchema,
  secretMatches,
  verifySecret,
} from './credentials.js';

const SESSION_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('refresh tokens', () => {
  it('round-trips: parse returns the session id and a secret matching the stored hash', () => {
    const { token, secretHash } = createRefreshToken(SESSION_ID);
    const parsed = parseRefreshToken(token);
    expect(parsed?.sessionId).toBe(SESSION_ID);
    expect(secretMatches(parsed!.secret, secretHash)).toBe(true);
  });

  it('does not store the secret itself', () => {
    const { token, secretHash } = createRefreshToken(SESSION_ID);
    expect(token).not.toContain(secretHash);
  });

  it('rejects a secret from another token', () => {
    const a = createRefreshToken(SESSION_ID);
    const b = createRefreshToken(SESSION_ID);
    expect(secretMatches(parseRefreshToken(b.token)!.secret, a.secretHash)).toBe(
      false,
    );
  });

  it.each(['', 'no-dot', '.secret', 'not-a-uuid.secret', `${SESSION_ID}.`])(
    'rejects malformed token %j',
    (token) => {
      expect(parseRefreshToken(token)).toBeNull();
    },
  );
});

describe('password hashing', () => {
  it('verifies the right password and rejects a wrong one', async () => {
    const hash = await hashSecret('rahasia-123');
    await expect(verifySecret(hash, 'rahasia-123')).resolves.toBe(true);
    await expect(verifySecret(hash, 'rahasia-124')).resolves.toBe(false);
  });

  it('returns false instead of throwing on a corrupt hash', async () => {
    await expect(verifySecret('not-a-hash', 'x')).resolves.toBe(false);
  });
});

describe('PIN format', () => {
  it.each([
    ['123456', true],
    ['12345', false],
    ['1234567', false],
    ['12a456', false],
  ])('%s -> %s', (pin, ok) => {
    expect(pinSchema.safeParse(pin).success).toBe(ok);
  });
});
