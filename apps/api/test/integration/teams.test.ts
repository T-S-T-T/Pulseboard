import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTeam, invite, join, SERVICE, signUp, startApp, type TestApp } from './helpers.js';

let target: TestApp;
beforeAll(async () => {
  target = await startApp();
});
afterAll(() => target.close());

describe('teams and roles', () => {
  it('makes the creator the owner', async () => {
    const owner = await signUp(target);
    const team = await createTeam(owner, 'Core Platform!');
    expect(team.slug).toMatch(/^core-platform-[0-9a-f]{8}$/);
    const detail = await owner.request('GET', `/api/teams/${team.id}`);
    expect(detail.body.team.role).toBe('owner');
    expect(detail.body.members).toHaveLength(1);
  });

  it('lets members read but not change anything', async () => {
    const owner = await signUp(target);
    const member = await signUp(target);
    const team = await createTeam(owner);
    await join(owner, member, team.id, 'member');
    const base = `/api/teams/${team.id}`;
    const created = await owner.request('POST', `${base}/services`, SERVICE);
    const service = `${base}/services/${created.body.service.id}`;

    expect((await member.request('GET', `${base}/services`)).body.services).toHaveLength(1);
    expect((await member.request('POST', `${base}/services`, SERVICE)).status).toBe(403);
    expect((await member.request('PATCH', service, { name: 'x' })).status).toBe(403);
    expect((await member.request('DELETE', service)).status).toBe(403);
    expect((await member.request('PATCH', base, { statusPageEnabled: true })).status).toBe(403);
    expect((await member.request('POST', `${base}/invites`, { role: 'member' })).status).toBe(403);
    expect(
      (await member.request('PATCH', `${base}/members/${member.id}`, { role: 'owner' })).status,
    ).toBe(403);
    expect((await member.request('DELETE', `${base}/members/${owner.id}`)).status).toBe(403);
  });

  it('lets admins manage services and invite members, but not create admins', async () => {
    const owner = await signUp(target);
    const admin = await signUp(target);
    const team = await createTeam(owner);
    await join(owner, admin, team.id, 'admin');
    const base = `/api/teams/${team.id}`;

    expect((await admin.request('POST', `${base}/services`, SERVICE)).status).toBe(201);
    expect((await admin.request('POST', `${base}/invites`, { role: 'member' })).status).toBe(201);
    expect((await admin.request('POST', `${base}/invites`, { role: 'admin' })).status).toBe(403);
  });

  it('uses each invite once', async () => {
    const owner = await signUp(target);
    const first = await signUp(target);
    const second = await signUp(target);
    const team = await createTeam(owner);
    const token = await invite(owner, team.id, 'member');

    // The owner opening their own link must not consume it.
    expect((await owner.request('POST', '/api/invites/accept', { token })).status).toBe(200);
    expect((await first.request('POST', '/api/invites/accept', { token })).status).toBe(200);
    expect((await second.request('POST', '/api/invites/accept', { token })).status).toBe(404);
  });

  it('cancels invites from someone who has been demoted or removed', async () => {
    const owner = await signUp(target);
    const admin = await signUp(target);
    const outsider = await signUp(target);
    const team = await createTeam(owner);
    await join(owner, admin, team.id, 'admin');
    const token = await invite(admin, team.id, 'member');

    const member = `/api/teams/${team.id}/members/${admin.id}`;
    await owner.request('PATCH', member, { role: 'member' });
    expect((await outsider.request('POST', '/api/invites/accept', { token })).status).toBe(404);
    await owner.request('DELETE', member);
    expect((await outsider.request('POST', '/api/invites/accept', { token })).status).toBe(404);
  });

  it('always keeps at least one owner', async () => {
    const owner = await signUp(target);
    const other = await signUp(target);
    const team = await createTeam(owner);
    const self = `/api/teams/${team.id}/members/${owner.id}`;

    expect((await owner.request('DELETE', self)).status).toBe(409);
    expect((await owner.request('PATCH', self, { role: 'member' })).status).toBe(409);

    await join(owner, other, team.id, 'member');
    await owner.request('PATCH', `/api/teams/${team.id}/members/${other.id}`, { role: 'owner' });
    expect((await owner.request('PATCH', self, { role: 'member' })).status).toBe(204);
  });

  it('lets a member leave', async () => {
    const owner = await signUp(target);
    const member = await signUp(target);
    const team = await createTeam(owner);
    await join(owner, member, team.id, 'member');
    const self = `/api/teams/${team.id}/members/${member.id}`;
    expect((await member.request('DELETE', self)).status).toBe(204);
    expect((await member.request('GET', `/api/teams/${team.id}`)).status).toBe(404);
  });

  it('limits teams per owner', async () => {
    const owner = await signUp(target);
    for (let i = 0; i < 5; i++) await createTeam(owner);
    expect((await owner.request('POST', '/api/teams', { name: 'Sixth' })).status).toBe(409);
  });
});
