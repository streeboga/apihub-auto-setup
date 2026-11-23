import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('../setup.mjs', import.meta.url));
const tool = 'select_claude_code_strategy';

function messageEvents(block, delta, stopReason) {
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'msg_mock',
        type: 'message',
        role: 'assistant',
        model: 'apihub-auto',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 15, output_tokens: 0 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: block },
    { type: 'content_block_delta', index: 0, delta },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

async function gatewayFixture(t, textResponse = false) {
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    calls.push({ method: req.method, path: req.url, headers: req.headers, body: body && JSON.parse(body) });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (textResponse) {
      res.end(messageEvents({ type: 'text', text: '' }, { type: 'text_delta', text: 'hello-api-hub' }, 'end_turn'));
      return;
    }
    res.end(messageEvents(
      { type: 'tool_use', id: 'toolu_setup', name: tool, input: {} },
      { type: 'input_json_delta', partial_json: '{"strategy":"cheaper"}' },
      'tool_use',
    ));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const dir = await mkdtemp(join(tmpdir(), 'apihub-pi-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const base = `http://127.0.0.1:${server.address().port}/g/v1`;
  const env = { ...process.env, CLAUDE_CONFIG_DIR: dir, APIHUB_TOKEN: 'test-agent-key' };
  return { calls, dir, base, env };
}

test('Pi requests one virtual model, uses the only setup tool, and applies its validated strategy', async (t) => {
  const { calls, dir, base, env } = await gatewayFixture(t);
  const result = await exec(process.execPath, [
    script, '--apply', '--gateway', base, '--agent', 'Настрой Claude Code для низкой цены',
  ], { env, timeout: 10_000 });
  assert.match(result.stdout, /apihub-auto \(cheaper\)/);
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.path.split('?')[0], '/g/v1/messages');
  assert.equal(call.headers.authorization, 'Bearer test-agent-key');
  assert.equal(call.headers['x-apihub-strategy'], 'reliable');
  assert.equal(call.body.model, 'apihub-auto');
  assert.deepEqual(call.body.tools.map(({ name }) => name), [tool]);
  assert.ok(!JSON.stringify(call.body).includes(env.APIHUB_TOKEN));
  const settings = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'));
  assert.equal(settings.env.ANTHROPIC_CUSTOM_HEADERS, 'X-APIHub-Strategy: cheaper');
});

test('Pi preview has no filesystem side effects', async (t) => {
  const { dir, base, env } = await gatewayFixture(t);
  const result = await exec(process.execPath, [
    script, '--dry-run', '--gateway', base, '--agent', 'Выбери дешёвый режим',
  ], { env, timeout: 10_000 });
  assert.match(result.stdout, /strategy cheaper/);
  assert.deepEqual(await readdir(dir), []);
});

test('Pi leaves settings alone when the model proposes no supported action', async (t) => {
  const { dir, base, env } = await gatewayFixture(t, true);
  await assert.rejects(exec(process.execPath, [
    script, '--apply', '--gateway', base, '--agent', 'Установи и настрой приложение XYZ',
  ], { env, timeout: 10_000 }), { stderr: /did not propose a supported Claude Code configuration/ });
  assert.deepEqual(await readdir(dir), []);
});

test('Claude Code CLI uses the installed gateway settings', {
  skip: !process.env.CLAUDE_CODE_SMOKE,
}, async (t) => {
  const { calls, dir, base, env } = await gatewayFixture(t, true);
  await exec(process.execPath, [script, '--apply', '--gateway', base, '--strategy', 'cheaper'], { env });
  const result = await exec(process.env.CLAUDE_CODE_SMOKE, [
    '-p', 'Say hello.',
  ], {
    cwd: dir,
    env: {
      HOME: dir,
      USERPROFILE: dir,
      PATH: process.env.PATH,
      CLAUDE_CONFIG_DIR: dir,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
    timeout: 30_000,
  });
  assert.match(result.stdout, /hello-api-hub/);
  const call = calls.find((entry) => entry.path.split('?')[0] === '/g/v1/messages');
  assert.ok(call, `Requests received: ${JSON.stringify(calls.map((entry) => entry.path))}`);
  assert.equal(call.body.model, 'apihub-auto');
  assert.equal(call.headers.authorization, 'Bearer test-agent-key');
  assert.equal(call.headers['x-apihub-strategy'], 'cheaper');
});
