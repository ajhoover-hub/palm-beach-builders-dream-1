/**
 * Authorization tests for the public email-queue helpers.
 *
 * These tests fail while anon and authenticated can still execute the helpers.
 * They pass once those roles can no longer enqueue, read, delete, or dead-letter
 * a message, and a message an outsider queued is not handed to the mail API.
 *
 * Run:
 *   node --test --test-concurrency=1 --test-timeout=180000 tests/email-queue-authorization.test.mjs
 *
 * Requires local PostgreSQL (the test starts cluster 16 if it is installed and stopped).
 * The test downloads PostgREST 14.12 and Deno when they are not already on disk.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { test, after } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationDir = path.join(root, 'supabase/migrations');
const workerPath = path.join(root, 'supabase/functions/process-email-queue/index.ts');
const pgmqPath = path.join(root, 'tests/fixtures/pgmq-1.5.1.sql');
const clientPath = path.join(root, 'src/integrations/supabase/client.ts');

const DB = 'email_queue_grant_test';
const JWT_SECRET = 'email-queue-test-jwt-secret-placeholder';
const DB_PASSWORD = 'email-queue-test-db-password';
const LOVABLE_API_KEY = 'email-queue-test-mail-api-key';

const state = {
  postgrest: null,
  proxy: null,
  mail: null,
  worker: null,
  postgrestPort: 0,
  proxyPort: 0,
  mailPort: 0,
  sentMail: [],
};

function sqlQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function psql(sql, database = DB) {
  const file = path.join(tmpdir(), `eq-${crypto.randomBytes(8).toString('hex')}.sql`);
  writeFileSync(file, sql);
  chmodSync(file, 0o644);
  return execFileSync(
    'sudo',
    ['-u', 'postgres', 'psql', '-d', database, '-v', 'ON_ERROR_STOP=1', '-At', '-f', file],
    { encoding: 'utf8' },
  ).trim();
}

function psqlFile(file, database = DB) {
  chmodSync(file, 0o644);
  execFileSync(
    'sudo',
    ['-u', 'postgres', 'psql', '-d', database, '-v', 'ON_ERROR_STOP=1', '-f', file],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

function ensurePostgres() {
  try {
    execFileSync('sudo', ['-u', 'postgres', 'psql', '-d', 'postgres', '-At', '-c', 'SELECT 1'], {
      stdio: 'ignore',
    });
  } catch {
    execFileSync('sudo', ['pg_ctlcluster', '16', 'main', 'start'], { stdio: 'inherit' });
  }
}

function ensureRole(name, extra) {
  psql(
    `DO $$ BEGIN
       CREATE ROLE ${name} ${extra};
     EXCEPTION WHEN duplicate_object THEN
       NULL;
     END $$;`,
    'postgres',
  );
}

function migrationSql() {
  const files = execFileSync('bash', ['-lc', `ls ${sqlQuote(migrationDir)}/*.sql`], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean)
    .sort();
  const parts = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split(/\n/);
    const kept = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('CREATE EXTENSION')) continue;
      if (line.startsWith('DO $$ BEGIN') && lines[i + 1] && lines[i + 1].includes('pg_cron')) {
        while (i < lines.length && !lines[i].trim().startsWith('END $$')) i++;
        continue;
      }
      kept.push(line);
    }
    parts.push(kept.join('\n'));
  }
  return parts.join('\n');
}

function setupDatabase() {
  psql(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${sqlQuote(DB)} AND pid <> pg_backend_pid();`,
    'postgres',
  );
  psql(`DROP DATABASE IF EXISTS ${DB};`, 'postgres');
  ensureRole('anon', 'NOLOGIN NOINHERIT');
  ensureRole('authenticated', 'NOLOGIN NOINHERIT');
  ensureRole('service_role', 'NOLOGIN NOINHERIT BYPASSRLS');
  ensureRole('authenticator', 'NOINHERIT LOGIN');
  psql(
    `ALTER ROLE authenticator PASSWORD ${sqlQuote(DB_PASSWORD)};
     GRANT anon TO authenticator;
     GRANT authenticated TO authenticator;
     GRANT service_role TO authenticator;
     ALTER ROLE anon SET statement_timeout = '3s';
     ALTER ROLE authenticated SET statement_timeout = '8s';`,
    'postgres',
  );
  psql(`CREATE DATABASE ${DB};`, 'postgres');

  // Supabase API roles and the function grants they receive on public objects.
  // Table and sequence data privileges are then revoked the way a project created
  // after May 2026 revokes them. That revoke does not remove function EXECUTE.
  psql(`
    GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role, authenticator;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
      GRANT ALL ON TABLES TO postgres, anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
      GRANT ALL ON FUNCTIONS TO postgres, anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
      GRANT ALL ON SEQUENCES TO postgres, anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
      REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
      REVOKE USAGE, SELECT ON SEQUENCES FROM anon, authenticated, service_role;

    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.role() RETURNS text
    LANGUAGE sql STABLE
    AS $$
      SELECT nullif(current_setting('request.jwt.claim.role', true), '')::text;
    $$;
    GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
  `);
  psqlFile(pgmqPath);
  const migrationFile = path.join(tmpdir(), 'email-queue-migration.sql');
  writeFileSync(migrationFile, migrationSql());
  psqlFile(migrationFile);
}

function signJwt(role) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ role, iss: 'email-queue-test' })).toString('base64url');
  const data = `${header}.${payload}`;
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(data).digest('base64url');
  return `${data}.${signature}`;
}

function ensurePostgrest() {
  const binary = '/tmp/postgrest-v14.12/postgrest';
  if (existsSync(binary)) return binary;
  execFileSync(
    'bash',
    [
      '-lc',
      'mkdir -p /tmp/postgrest-v14.12 && curl -fsSL -o /tmp/postgrest-v14.12.tar.xz -L "https://github.com/PostgREST/postgrest/releases/download/v14.12/postgrest-v14.12-linux-static-x86-64.tar.xz" && tar -xJf /tmp/postgrest-v14.12.tar.xz -C /tmp/postgrest-v14.12',
    ],
    { stdio: 'inherit' },
  );
  return binary;
}

function ensureDeno() {
  try {
    execFileSync('deno', ['--version'], { stdio: 'ignore' });
    return 'deno';
  } catch {
    // installed below
  }
  if (existsSync('/tmp/deno/bin/deno')) return '/tmp/deno/bin/deno';
  execFileSync('bash', ['-lc', 'curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/tmp/deno sh'], {
    stdio: 'inherit',
  });
  return '/tmp/deno/bin/deno';
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function startHttp() {
  const postgrestBinary = ensurePostgrest();
  const configDir = mkdtempSync(path.join(tmpdir(), 'pgrst-'));
  const configPath = path.join(configDir, 'postgrest.conf');
  writeFileSync(
    configPath,
    [
      `db-uri = "postgres://authenticator:${DB_PASSWORD}@127.0.0.1:5432/${DB}"`,
      'db-schemas = "public"',
      'db-anon-role = "anon"',
      'db-extra-search-path = "public"',
      `jwt-secret = "${JWT_SECRET}"`,
      'server-host = "127.0.0.1"',
      'server-port = 0',
    ].join('\n'),
  );
  // PostgREST requires a fixed port in the config file. Claim one, then start.
  const probe = createServer();
  state.postgrestPort = await listen(probe);
  await new Promise((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  writeFileSync(configPath, readFileSync(configPath, 'utf8').replace('server-port = 0', `server-port = ${state.postgrestPort}`));

  const logPath = path.join(configDir, 'postgrest.log');
  const log = spawn('bash', ['-lc', `"${postgrestBinary}" "${configPath}" > "${logPath}" 2>&1`]);
  state.postgrest = log;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const ready = await fetch(`http://127.0.0.1:${state.postgrestPort}/`);
      await ready.arrayBuffer();
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  const open = await fetch(`http://127.0.0.1:${state.postgrestPort}/`).then(
    () => true,
    () => false,
  );
  if (!open) {
    throw new Error(`PostgREST did not start\n${existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''}`);
  }

  const proxy = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (key === 'host' || key === 'connection' || key === 'content-length') continue;
      if (Array.isArray(value)) value.forEach((item) => headers.append(key, item));
      else if (value) headers.set(key, value);
    }
    const upstreamPath = (req.url || '/').replace(/^\/rest\/v1/, '') || '/';
    const upstream = await fetch(`http://127.0.0.1:${state.postgrestPort}${upstreamPath}`, {
      method: req.method,
      headers,
      body: body.length > 0 && req.method !== 'GET' && req.method !== 'HEAD' ? body : undefined,
    });
    const responseBody = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') || 'application/json',
    });
    res.end(responseBody);
  });
  state.proxy = proxy;
  state.proxyPort = await listen(proxy);

  const mail = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    if (req.url && req.url.endsWith('/prepare-uploads')) {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'POST' && req.url && req.url.endsWith('/v1/messaging/email/send')) {
      state.sentMail.push(body);
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'test-mail' }));
  });
  state.mail = mail;
  state.mailPort = await listen(mail);
}

async function startWorker() {
  const deno = ensureDeno();
  const importMap = path.join(tmpdir(), 'email-queue-import-map.json');
  writeFileSync(
    importMap,
    JSON.stringify({
      imports: {
        'npm:@lovable.dev/email-js': 'npm:@lovable.dev/email-js@0.8.0',
        'npm:@supabase/supabase-js@2': 'npm:@supabase/supabase-js@2.91.0',
      },
    }),
  );
  const child = spawn(
    deno,
    ['run', '--allow-net', '--allow-env', `--import-map=${importMap}`, workerPath],
    {
      env: {
        ...process.env,
        SUPABASE_URL: `http://127.0.0.1:${state.proxyPort}`,
        SUPABASE_SERVICE_ROLE_KEY: signJwt('service_role'),
        LOVABLE_API_KEY,
        LOVABLE_SEND_URL: `http://127.0.0.1:${state.mailPort}/v1/messaging/email/send`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  state.worker = child;
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (output.includes('Listening on')) break;
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!output.includes('Listening on')) {
    throw new Error(`email worker did not start\n${output}`);
  }
}

function stopChild(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  child.kill('SIGTERM');
}

async function rpc(role, fn, args) {
  const token = signJwt(role);
  const response = await fetch(`http://127.0.0.1:${state.postgrestPort}/rpc/${fn}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      apikey: token,
    },
    body: JSON.stringify(args),
  });
  const body = await response.text();
  return { status: response.status, body };
}

function queueCount(queue, marker) {
  const table = `pgmq.q_${queue}`;
  return Number(
    psql(
      `SELECT count(*) FROM ${table} WHERE message::text LIKE ${sqlQuote(`%${marker}%`)};`,
    ),
  );
}

function readCount(queue, marker) {
  const table = `pgmq.q_${queue}`;
  const value = psql(
    `SELECT coalesce(max(read_ct), -1) FROM ${table} WHERE message::text LIKE ${sqlQuote(`%${marker}%`)};`,
  );
  return Number(value);
}

function publishableKeyRole() {
  const source = readFileSync(clientPath, 'utf8');
  const match = source.match(/SUPABASE_PUBLISHABLE_KEY\s*=[\s\S]*?\|\|\s*'([^']+)'/);
  assert.ok(match, 'browser client does not embed a publishable key fallback');
  const payload = JSON.parse(Buffer.from(match[1].split('.')[1], 'base64url').toString('utf8'));
  return payload.role;
}

function stopAll() {
  stopChild(state.worker);
  stopChild(state.postgrest);
  state.proxy?.close();
  state.mail?.close();
}

after(() => {
  stopAll();
});

test('email queue helpers are not executable by anon or authenticated', async (t) => {
  ensurePostgres();
  setupDatabase();
  await startHttp();
  await startWorker();

  await t.test('the browser client is configured with an anon publishable key', () => {
    assert.equal(publishableKeyRole(), 'anon');
  });

  const callers = [
    { role: 'anon', queue: 'transactional_emails' },
    { role: 'authenticated', queue: 'auth_emails' },
  ];

  for (const { role, queue } of callers) {
    await t.test(`${role} cannot enqueue an HTML email on ${queue}`, async () => {
      const marker = `${role}-enqueue-${queue}`;
      const before = queueCount(queue, marker);
      const response = await rpc(role, 'enqueue_email', {
        queue_name: queue,
        payload: {
          to: 'prospect@example.com',
          from: 'Beau Monde Builders <noreply@bmbpalmbeach.com>',
          sender_domain: 'notify.bmbpalmbeach.com',
          subject: 'Inquiry',
          html: `<p>${marker}</p>`,
          text: marker,
          unsubscribe_token: `token-${marker}`,
          message_id: marker,
        },
      });
      assert.ok(response.status >= 400, `${role} enqueue returned ${response.status} ${response.body}`);
      assert.equal(queueCount(queue, marker), before);
    });

    await t.test(`${role} cannot read queued prospect details on ${queue}`, async () => {
      const marker = `${role}-read-${queue}`;
      const seeded = await rpc('service_role', 'enqueue_email', {
        queue_name: queue,
        payload: {
          to: 'owner@example.com',
          name: 'Pat Example',
          phone: '555-0100',
          unsubscribe_token: `token-${marker}`,
          message_id: marker,
          html: `<p>${marker}</p>`,
        },
      });
      assert.equal(seeded.status, 200, seeded.body);
      assert.equal(readCount(queue, marker), 0);
      const response = await rpc(role, 'read_email_batch', {
        queue_name: queue,
        batch_size: 10,
        vt: 30,
      });
      assert.ok(response.status >= 400, `${role} read returned ${response.status} ${response.body}`);
      assert.equal(response.body.includes(marker), false);
      assert.equal(response.body.includes(`token-${marker}`), false);
      assert.equal(readCount(queue, marker), 0);
      assert.equal(queueCount(queue, marker), 1);
    });

    await t.test(`${role} cannot delete a queued inquiry on ${queue}`, async () => {
      const marker = `${role}-delete-${queue}`;
      const seeded = await rpc('service_role', 'enqueue_email', {
        queue_name: queue,
        payload: { message_id: marker, to: 'owner@example.com', html: `<p>${marker}</p>` },
      });
      assert.equal(seeded.status, 200, seeded.body);
      const messageId = Number(seeded.body);
      const response = await rpc(role, 'delete_email', {
        queue_name: queue,
        message_id: messageId,
      });
      assert.ok(response.status >= 400, `${role} delete returned ${response.status} ${response.body}`);
      assert.equal(queueCount(queue, marker), 1);
    });

    await t.test(`${role} cannot move a queued inquiry to the dead-letter queue on ${queue}`, async () => {
      const marker = `${role}-dlq-${queue}`;
      const seeded = await rpc('service_role', 'enqueue_email', {
        queue_name: queue,
        payload: { message_id: marker, to: 'owner@example.com', html: `<p>${marker}</p>` },
      });
      assert.equal(seeded.status, 200, seeded.body);
      const messageId = Number(seeded.body);
      const response = await rpc(role, 'move_to_dlq', {
        source_queue: queue,
        dlq_name: `${queue}_dlq`,
        message_id: messageId,
        payload: { message_id: marker, to: 'owner@example.com', html: `<p>${marker}</p>` },
      });
      assert.ok(response.status >= 400, `${role} move_to_dlq returned ${response.status} ${response.body}`);
      assert.equal(queueCount(queue, marker), 1);
      assert.equal(queueCount(`${queue}_dlq`, marker), 0);
    });
  }

  await t.test('the worker sends a service-role message and does not send an anon-queued message', async () => {
    psql('DELETE FROM pgmq.q_transactional_emails; DELETE FROM pgmq.q_auth_emails;');
    state.sentMail.length = 0;
    const allowed = 'service-role-marker';
    const planted = 'anon-attacker-marker';
    const allowedEnqueue = await rpc('service_role', 'enqueue_email', {
      queue_name: 'transactional_emails',
      payload: {
        to: 'customer@example.com',
        from: 'Beau Monde Builders <noreply@bmbpalmbeach.com>',
        sender_domain: 'notify.bmbpalmbeach.com',
        subject: 'Allowed',
        html: `<p>${allowed}</p>`,
        text: allowed,
        message_id: allowed,
      },
    });
    assert.equal(allowedEnqueue.status, 200, allowedEnqueue.body);

    const attack = await rpc('anon', 'enqueue_email', {
      queue_name: 'transactional_emails',
      payload: {
        to: 'outsider@example.com',
        from: 'Beau Monde Builders <noreply@bmbpalmbeach.com>',
        sender_domain: 'notify.bmbpalmbeach.com',
        subject: 'Spoofed inquiry',
        html: `<p>${planted}</p>`,
        text: planted,
        unsubscribe_token: `token-${planted}`,
        message_id: planted,
      },
    });
    const plantedBeforeWorker = queueCount('transactional_emails', planted);

    const workerResponse = await fetch('http://127.0.0.1:8000/', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${signJwt('service_role')}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    const workerBody = await workerResponse.text();
    const sent = state.sentMail.join('\n');
    const problems = [];
    if (allowedEnqueue.status !== 200) problems.push(`service_role enqueue ${allowedEnqueue.status} ${allowedEnqueue.body}`);
    if (workerResponse.status !== 200) problems.push(`worker ${workerResponse.status} ${workerBody}`);
    if (!sent.includes(allowed)) problems.push(`worker did not send the service-role message: ${sent}`);
    if (!sent.includes('"sender_domain":"notify.bmbpalmbeach.com"')) {
      problems.push(`mail request omitted sender_domain: ${sent}`);
    }
    if (attack.status < 400) problems.push(`anon enqueue returned ${attack.status} ${attack.body}`);
    if (plantedBeforeWorker !== 0) problems.push(`anon enqueue stored ${plantedBeforeWorker} message(s)`);
    if (sent.includes(planted)) problems.push(`worker sent the anon-queued message: ${sent}`);
    assert.deepEqual(problems, []);
  });
});
