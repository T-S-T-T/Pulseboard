import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/security/password.js';

describe('password hashing', () => {
  it('verifies the right password only', async () => {
    const hash = await hashPassword('correct horse battery');
    await expect(verifyPassword('correct horse battery', hash)).resolves.toBe(true);
    await expect(verifyPassword('correct horse batterz', hash)).resolves.toBe(false);
  });

  it('salts every hash', async () => {
    expect(await hashPassword('same password')).not.toBe(await hashPassword('same password'));
  });

  it('rejects an unrecognised format', async () => {
    await expect(verifyPassword('x', 'plaintext')).resolves.toBe(false);
  });
});
