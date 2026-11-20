/**
 * Spec for the public transactional-email relay.
 *
 * These tests fail while an anon-key caller can enqueue branded mail.
 * They pass once that caller is refused before any queue write or provider
 * request. The gateway check below is the Supabase edge gateway from
 * supabase/cli v2.22.12 internal/functions/serve/templates/main.ts
 * (verifyJWT uses jose@v4.13.1 jwtVerify with the project secret and no role
 * allow-list). It is not a substitute for the function under test.
 */
import * as jose from "https://deno.land/x/jose@v4.13.1/index.ts";

const JWT_SECRET = "test-jwt-secret-placeholder-at-least-32-chars";
const VICTIM = "victim@example.test";
const OFFICE = "ajhoover@mac.com";
const MARKER = "ATTACKER-WORDING-MARKER";
const PAD = "P".repeat(2000);
const FUNCTION_PORT = 8000;

type Queued = {
  queue_name: string;
  payload: Record<string, unknown>;
};

type CapturedSend = {
  url: string;
  body: Record<string, unknown>;
};

const secretKey = new TextEncoder().encode(JWT_SECRET);

async function signToken(role: string): Promise<string> {
  return await new jose.SignJWT({ role, ref: "test-project-ref" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer("supabase")
    .setIssuedAt()
    .setExpirationTime("2h")
    .sign(secretKey);
}

/**
 * Same decision as the edge gateway: missing or bad signature is rejected;
 * any HS256 JWT signed with the project secret is forwarded, including role
 * "anon". jose jwtVerify (v4.13.1 jwt/verify.ts) checks the signature and
 * exp/nbf only when no issuer/audience/subject options are passed.
 */
async function gatewayForwards(authorization: string | null): Promise<boolean> {
  if (!authorization) return false;
  const [bearer, token] = authorization.split(" ");
  if (bearer !== "Bearer" || !token) return false;
  try {
    await jose.jwtVerify(token, secretKey);
    return true;
  } catch {
    return false;
  }
}

function eqFilter(url: URL, column: string): string | null {
  const raw = url.searchParams.get(column);
  if (!raw || !raw.startsWith("eq.")) return null;
  return decodeURIComponent(raw.slice(3));
}

function startSupabaseMock(state: {
  tokens: Map<string, { token: string; email: string; used_at: null }>;
  queued: Queued[];
  logs: Array<Record<string, unknown>>;
  requests: string[];
  deleted: Set<number>;
}) {
  return Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, async (req) => {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/$/, "");
    const bodyText = req.method === "GET" || req.method === "HEAD" ? "" : await req.text();
    state.requests.push(`${req.method} ${path}${url.search}`);
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (path.endsWith("/suppressed_emails")) return json([]);

    if (path.endsWith("/email_unsubscribe_tokens")) {
      if (req.method === "GET") {
        const email = eqFilter(url, "email");
        const row = email ? state.tokens.get(email) : undefined;
        return json(row ? [row] : []);
      }
      const parsed = JSON.parse(bodyText) as { token: string; email: string };
      if (!state.tokens.has(parsed.email)) {
        state.tokens.set(parsed.email, {
          token: parsed.token,
          email: parsed.email,
          used_at: null,
        });
      }
      return new Response(null, { status: 201 });
    }

    if (path.endsWith("/email_send_log")) {
      if (req.method === "GET") return json([]);
      state.logs.push(JSON.parse(bodyText) as Record<string, unknown>);
      return new Response(null, { status: 201 });
    }

    if (path.endsWith("/email_send_state")) {
      const row = {
        id: 1,
        retry_after_until: null,
        batch_size: 10,
        send_delay_ms: 0,
        auth_email_ttl_minutes: 15,
        transactional_email_ttl_minutes: 60,
      };
      const accept = req.headers.get("accept") ?? "";
      if (accept.includes("application/vnd.pgrst.object+json")) return json(row);
      return json([row]);
    }

    if (path.endsWith("/rpc/enqueue_email")) {
      const parsed = JSON.parse(bodyText) as Queued;
      state.queued.push(parsed);
      return json(state.queued.length);
    }

    if (path.endsWith("/rpc/read_email_batch")) {
      const parsed = JSON.parse(bodyText) as { queue_name: string };
      const messages = state.queued
        .map((item, index) => ({ item, index }))
        .filter(({ item, index }) =>
          item.queue_name === parsed.queue_name && !state.deleted.has(index + 1)
        )
        .map(({ item, index }) => ({
          msg_id: index + 1,
          read_ct: 1,
          enqueued_at: new Date().toISOString(),
          message: item.payload,
        }));
      return json(messages);
    }

    if (path.endsWith("/rpc/delete_email")) {
      const parsed = JSON.parse(bodyText) as { message_id: number };
      state.deleted.add(parsed.message_id);
      return json(true);
    }

    return json({ message: `unhandled ${req.method} ${path}` }, 404);
  });
}

function startEmailApi(captured: CapturedSend[]) {
  return Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, async (req) => {
    const url = new URL(req.url);
    const bodyText = req.method === "GET" || req.method === "HEAD" ? "" : await req.text();
    if (url.pathname.endsWith("/prepare-uploads")) {
      return new Response(null, { status: 204 });
    }
    let body: Record<string, unknown> = {};
    if (bodyText) body = JSON.parse(bodyText) as Record<string, unknown>;
    captured.push({ url: url.pathname, body });
    if (url.pathname.endsWith("/emails") || url.pathname.endsWith("/send")) {
      return new Response(JSON.stringify({ id: "local-message", success: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ message: "unhandled" }), { status: 404 });
  });
}

function addrPort(server: Deno.HttpServer): number {
  const addr = server.addr;
  if (typeof addr === "object" && addr !== null && "port" in addr) {
    return Number(addr.port);
  }
  throw new Error("mock server did not expose a port");
}

async function pump(stream: ReadableStream<Uint8Array>, sink: string[]) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      sink.push(decoder.decode(value));
    }
  } catch {
    // The process is killed when the test finishes.
  }
}

function startFunction(
  cwd: string,
  env: Record<string, string>,
): { child: Deno.ChildProcess; logs: () => string } {
  const sink: string[] = [];
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-net", "--allow-env", "index.ts"],
    cwd,
    env: { ...Deno.env.toObject(), ...env },
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  pump(child.stdout, sink);
  pump(child.stderr, sink);
  return { child, logs: () => sink.join("") };
}

async function stopFunction(child: Deno.ChildProcess) {
  try {
    child.kill("SIGKILL");
  } catch {
    // already exited
  }
  try {
    await child.status;
  } catch {
    // already awaited
  }
  // Deno.serve keeps the port for a moment after SIGKILL.
  await new Promise((resolve) => setTimeout(resolve, 200));
}

async function waitUntilReady(authorization: string, logs: () => string) {
  const deadline = Date.now() + 120_000;
  let lastError = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${FUNCTION_PORT}/`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization,
        },
        body: "{}",
      });
      await response.text();
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw new Error(`function did not listen on ${FUNCTION_PORT}: ${lastError}\n${logs()}`);
}

async function postJson(
  authorization: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  const response = await fetch(`http://127.0.0.1:${FUNCTION_PORT}/`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { raw: text };
  }
  return { status: response.status, body: parsed, text };
}

function containsMarker(value: unknown): boolean {
  return typeof value === "string" && (value.includes(MARKER) || value.includes(PAD));
}

Deno.test("edge gateway forwards an anon JWT and rejects a bad signature", async () => {
  const anon = await signToken("anon");
  const otherSecret = new TextEncoder().encode("different-test-secret-placeholder-32");
  const forged = await new jose.SignJWT({ role: "service_role" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("supabase")
    .setExpirationTime("2h")
    .sign(otherSecret);

  if (!await gatewayForwards(`Bearer ${anon}`)) {
    throw new Error("anon JWT signed with the project secret was rejected");
  }
  if (await gatewayForwards(`Bearer ${forged}`)) {
    throw new Error("JWT signed with a different secret was forwarded");
  }
  if (await gatewayForwards(null)) {
    throw new Error("missing Authorization was forwarded");
  }
});

Deno.test({
  name: "anon caller cannot queue or send branded confirmation or notification mail",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const state = {
      tokens: new Map<string, { token: string; email: string; used_at: null }>(),
      queued: [] as Queued[],
      logs: [] as Array<Record<string, unknown>>,
      requests: [] as string[],
      deleted: new Set<number>(),
    };
    const outbound: CapturedSend[] = [];
    const supabase = startSupabaseMock(state);
    const emailApi = startEmailApi(outbound);
    const supabasePort = addrPort(supabase);
    const emailPort = addrPort(emailApi);
    const anon = await signToken("anon");
    const authorization = `Bearer ${anon}`;
    if (!await gatewayForwards(authorization)) {
      throw new Error("test gateway rejected the anon JWT the attack uses");
    }

    const root = new URL("../", import.meta.url);
    const sendDir = new URL("./send-transactional-email/", root).pathname;
    const workerDir = new URL("./process-email-queue/", root).pathname;
    const sender = startFunction(sendDir, {
      SUPABASE_URL: `http://127.0.0.1:${supabasePort}`,
      SUPABASE_SERVICE_ROLE_KEY: "service-role-placeholder",
    });

    const attacks = [
      {
        templateName: "contact-confirmation",
        recipientEmail: VICTIM,
        templateData: { firstName: `${MARKER} ${PAD}` },
      },
      {
        templateName: "style-book-confirmation",
        recipientEmail: VICTIM,
        templateData: { firstName: MARKER, style: `${MARKER} ${PAD}` },
      },
      {
        templateName: "contact-notification",
        recipientEmail: VICTIM,
        templateData: {
          fullName: MARKER,
          email: VICTIM,
          message: `${MARKER} ${PAD}`,
        },
      },
      {
        templateName: "style-book-notification",
        recipientEmail: VICTIM,
        templateData: {
          fullName: MARKER,
          email: VICTIM,
          style: MARKER,
          message: `${MARKER} ${PAD}`,
        },
      },
    ];

    try {
      await waitUntilReady(authorization, sender.logs);
      const responses = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        for (const attack of attacks) {
          const result = await postJson(authorization, {
            ...attack,
            idempotencyKey: `attack-${attack.templateName}-${attempt}`,
          });
          responses.push({ templateName: attack.templateName, ...result });
        }
      }

      const harness = responses.filter((result) => result.status >= 500);
      if (harness.length > 0) {
        throw new Error(
          `send-transactional-email failed before an allow or deny decision: ${
            JSON.stringify(harness.map((result) => ({
              templateName: result.templateName,
              status: result.status,
              body: result.body,
            })))
          }\nrequests: ${state.requests.join(" | ")}\n${sender.logs()}`,
        );
      }

      await stopFunction(sender.child);

      const service = await signToken("service_role");
      const worker = startFunction(workerDir, {
        SUPABASE_URL: `http://127.0.0.1:${supabasePort}`,
        SUPABASE_SERVICE_ROLE_KEY: "service-role-placeholder",
        LOVABLE_API_KEY: "lovable-api-key-placeholder",
        LOVABLE_SEND_URL: `http://127.0.0.1:${emailPort}/v1/messaging/email/send`,
      });
      try {
        await waitUntilReady(`Bearer ${service}`, worker.logs);
        const drained = await postJson(`Bearer ${service}`, {});
        if (drained.status >= 500) {
          throw new Error(
            `process-email-queue failed: ${drained.status} ${drained.text}\n${worker.logs()}`,
          );
        }
      } finally {
        await stopFunction(worker.child);
      }

      const accepted = responses.filter((result) =>
        result.status === 200 &&
        (result.body.queued === true || result.body.success === true)
      );
      const relayed = state.queued.filter((item) => {
        const payload = item.payload;
        return containsMarker(payload.subject) || containsMarker(payload.html) ||
          containsMarker(payload.text) || payload.to === VICTIM;
      });
      const sent = outbound.filter((item) => {
        const body = item.body;
        return containsMarker(body.subject) || containsMarker(body.html) ||
          containsMarker(body.text) || body.to === VICTIM || body.to === OFFICE;
      });

      if (accepted.length === 0 && relayed.length === 0 && sent.length === 0) {
        const refused = responses.every((result) =>
          result.status === 400 || result.status === 401 || result.status === 403
        );
        if (!refused) {
          throw new Error(
            `anon caller was not refused: ${
              JSON.stringify(responses.map((result) => ({
                templateName: result.templateName,
                status: result.status,
                body: result.body,
              })))
            }`,
          );
        }
        return;
      }

      const clip = (value: unknown) => String(value ?? "").slice(0, 80);
      const describe = (payload: Record<string, unknown> | undefined) =>
        payload
          ? `to=${clip(payload.to)} from=${clip(payload.from)} subject=${clip(payload.subject)} markerInHtml=${containsMarker(payload.html)}`
          : "none";
      const queuedConfirmation = relayed.find((item) => item.payload.to === VICTIM)?.payload;
      const queuedOffice = relayed.find((item) => item.payload.to === OFFICE)?.payload;
      const sentConfirmation = sent.find((item) => item.body.to === VICTIM)?.body;
      const sentOffice = sent.find((item) => item.body.to === OFFICE)?.body;
      throw new Error(
        [
          `anon JWT queued ${relayed.length} message(s) and the worker submitted ${sent.length}.`,
          `Accepted responses: ${accepted.length} of ${responses.length}.`,
          `Queued confirmation: ${describe(queuedConfirmation)}`,
          `Queued office notification: ${describe(queuedOffice)}`,
          `Sent confirmation: ${describe(sentConfirmation)}`,
          `Sent office notification: ${describe(sentOffice)}`,
        ].join("\n"),
      );
    } finally {
      await stopFunction(sender.child);
      await supabase.shutdown();
      await emailApi.shutdown();
    }
  },
});

Deno.test({
  name: "anon caller cannot relay mail through send-contact-email",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const outbound: CapturedSend[] = [];
    const emailApi = startEmailApi(outbound);
    const emailPort = addrPort(emailApi);
    const anon = await signToken("anon");
    const authorization = `Bearer ${anon}`;
    if (!await gatewayForwards(authorization)) {
      throw new Error("test gateway rejected the anon JWT the attack uses");
    }

    const root = new URL("../", import.meta.url);
    const dir = new URL("./send-contact-email/", root).pathname;
    const sender = startFunction(dir, {
      RESEND_API_KEY: "re_test_placeholder",
      RESEND_BASE_URL: `http://127.0.0.1:${emailPort}`,
    });

    try {
      await waitUntilReady(authorization, sender.logs);
      const calls = [
        {
          firstName: `${MARKER} ${PAD}`,
          lastName: "Caller",
          email: VICTIM,
          message: `${MARKER} ${PAD}`,
        },
        {
          firstName: MARKER,
          email: VICTIM,
          style: `${MARKER} ${PAD}`,
          source: "style-book",
        },
      ];
      const responses = [];
      for (const body of calls) {
        responses.push(await postJson(authorization, body));
      }

      const harness = responses.filter((result) => result.status >= 500);
      if (harness.length > 0 && outbound.length === 0) {
        throw new Error(
          `send-contact-email failed before an allow or deny decision: ${
            JSON.stringify(harness)
          }\n${sender.logs()}`,
        );
      }

      const relayed = outbound.filter((item) =>
        containsMarker(item.body.html) || containsMarker(item.body.subject) ||
        item.body.to === VICTIM ||
        (Array.isArray(item.body.to) && item.body.to.includes(VICTIM)) ||
        (Array.isArray(item.body.to) && item.body.to.includes(OFFICE))
      );
      const accepted = responses.filter((result) =>
        result.status === 200 && result.body.success === true
      );

      if (accepted.length === 0 && relayed.length === 0) {
        const refused = responses.every((result) =>
          result.status === 400 || result.status === 401 || result.status === 403
        );
        if (!refused) {
          throw new Error(
            `anon caller was not refused by send-contact-email: ${JSON.stringify(responses)}`,
          );
        }
        return;
      }

      const clip = (value: unknown) => {
        const text = Array.isArray(value) ? value.join(",") : String(value ?? "");
        return text.slice(0, 80);
      };
      const victimPost = relayed.find((item) => {
        const to = item.body.to;
        return to === VICTIM || (Array.isArray(to) && to.includes(VICTIM));
      })?.body;
      const officePost = relayed.find((item) => {
        const to = item.body.to;
        return to === OFFICE || (Array.isArray(to) && to.includes(OFFICE));
      })?.body;
      const describe = (payload: Record<string, unknown> | undefined) =>
        payload
          ? `to=${clip(payload.to)} from=${clip(payload.from)} subject=${clip(payload.subject)} markerInHtml=${containsMarker(payload.html)}`
          : "none";
      throw new Error(
        [
          `send-contact-email accepted ${accepted.length} anon request(s) and posted ${relayed.length} provider message(s).`,
          `Confirmation post: ${describe(victimPost)}`,
          `Office post: ${describe(officePost)}`,
        ].join("\n"),
      );
    } finally {
      await stopFunction(sender.child);
      await emailApi.shutdown();
    }
  },
});
