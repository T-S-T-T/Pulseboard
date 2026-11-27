import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

const base = { DATABASE_URL: 'postgres://x', APP_URL: 'https://pulse.example.com/' };

describe('configuration', () => {
  it('normalises the app URL to an origin and treats blanks as unset', () => {
    const config = loadConfig({ ...base, OIDC_ISSUER: '', PORT: '' });
    expect(config).toMatchObject({ APP_URL: 'https://pulse.example.com', PORT: 4000 });
    expect(config.OIDC_ISSUER).toBeUndefined();
  });

  it('fails fast when something is missing', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ ...base, OIDC_ISSUER: 'https://id.example.com' })).toThrow(
      /OIDC_CLIENT_ID/,
    );
  });
});
