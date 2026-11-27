import { expect, test } from '@playwright/test';
import { safeNextPath } from '../apps/web/src/lib/redirect';

test('the post-sign-in redirect keeps paths on this site', () => {
  expect(safeNextPath('/teams/abc?tab=1#x')).toBe('/teams/abc?tab=1#x');
  expect(safeNextPath('/invite#token')).toBe('/invite#token');
});

test('the post-sign-in redirect refuses other destinations', () => {
  for (const next of [
    null,
    '',
    'https://evil.example',
    'javascript:alert(1)',
    '//evil.example',
    '/\\evil.example',
    '/\t/evil.example',
    '/.//evil.example',
    '/..//evil.example',
    '/%2e//evil.example',
    '/a/..//evil.example',
  ]) {
    expect(safeNextPath(next), JSON.stringify(next)).toBe('/dashboard');
  }
});
