import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { exchangeGithubCode, identifyGithubUser } = createRequire(import.meta.url)('../src/issue-gateway/github-oauth.ts');
const config = { clientId: 'пример-id', clientSecret: 'фиктивный-секрет', callbackUrl: 'https://worker.example/callback' };
const accepted = { status: 'accepted', verifier: 'a'.repeat(43) };

test('обмен отправляет тестовые данные только в теле POST, без утечки в URL', async () => {
  let request;
  const fetcher = async (url, init) => {
    request = { url, init };
    return Response.json({ access_token: 'фиктивный-токен', token_type: 'bearer', expires_in: 28800, refresh_token: 'не возвращать' });
  };
  const result = await exchangeGithubCode(config, accepted, 'фиктивный-код', fetcher);
  assert.deepEqual(result, { status: 'accepted', accessToken: 'фиктивный-токен', expiresIn: 28800 });
  assert.equal(request.url, 'https://github.com/login/oauth/access_token');
  assert.equal(request.init.redirect, 'error');
  assert.equal(request.init.method, 'POST');
  const body = new URLSearchParams(request.init.body);
  assert.equal(body.get('code_verifier'), accepted.verifier);
  assert.equal(body.get('client_secret'), config.clientSecret);
  assert.equal(body.get('redirect_uri'), config.callbackUrl);
  assert.equal(body.get('repository_id'), '1421259694');
  assert.equal(request.url.includes(config.clientSecret), false);
  assert.equal(JSON.stringify(result).includes('не возвращать'), false);
});

test('без валидного state/PKCE и корректной настройки сеть не вызывается', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return Response.json({}); };
  for (const [cfg, state, code] of [
    [config, { status: 'invalid' }, 'код'],
    [config, { status: 'accepted', verifier: 'short' }, 'код'],
    [{ ...config, callbackUrl: 'http://worker.example/callback' }, accepted, 'код'],
    [{ ...config, callbackUrl: 'https://worker.example/callback?next=x' }, accepted, 'код'],
    [config, accepted, 'код\n'],
  ]) assert.deepEqual(await exchangeGithubCode(cfg, state, code, fetcher), { status: 'invalid' });
  assert.equal(calls, 0);
});

test('ошибки ответа и сети не раскрывают детали и не повторяют обмен', async () => {
  let calls = 0;
  const failed = async () => { calls++; throw new Error('фиктивный-секрет'); };
  assert.deepEqual(await exchangeGithubCode(config, accepted, 'код', failed), { status: 'unavailable' });
  assert.equal(calls, 1);
  assert.deepEqual(await exchangeGithubCode(config, accepted, 'код', async () => new Response('', { status: 503 })), { status: 'unavailable' });
  assert.deepEqual(await exchangeGithubCode(config, accepted, 'код', async () => Response.json({ error: 'bad_verification_code' })), { status: 'rejected' });
  assert.deepEqual(await exchangeGithubCode(config, accepted, 'код', async () => Response.json({ access_token: 'токен', token_type: 'basic' })), { status: 'rejected' });
});

test('идентификация запрашивает пользователя GitHub и отдаёт только id и login', async () => {
  const result = await identifyGithubUser('фиктивный-токен', async (url, init) => {
    assert.equal(url, 'https://api.github.com/user');
    assert.equal(init.headers.Authorization, 'Bearer фиктивный-токен');
    assert.equal(init.redirect, 'error');
    return Response.json({ id: 42, login: 'Example-User', type: 'User', extra: 'игнорируется' });
  });
  assert.deepEqual(result, { status: 'identified', user: { id: 42, login: 'Example-User' } });
  assert.equal(JSON.stringify(result).includes('фиктивный-токен'), false);
});

test('неизвестная личность, отказ API и сбой не разрешают операцию', async () => {
  assert.deepEqual(await identifyGithubUser('', async () => Response.json({})), { status: 'invalid' });
  assert.deepEqual(await identifyGithubUser('токен', async () => Response.json({ id: 42, login: 'Example', type: 'Bot' })), { status: 'rejected' });
  assert.deepEqual(await identifyGithubUser('токен', async () => new Response('', { status: 401 })), { status: 'rejected' });
  assert.deepEqual(await identifyGithubUser('токен', async () => new Response('', { status: 429 })), { status: 'unavailable' });
});
