/**
 * Spec for the legacy send-contact-email handler.
 *
 * A caller who only presents the public client credential (the handler never
 * inspects it) must not be able to place live markup in the office notice or
 * the visitor confirmation. These tests fail while submitted fields are pasted
 * into the HTML body. They pass when every interpolated field is escaped, or
 * when the handler refuses the request before any email payload is handed to
 * the mail API.
 *
 * Run:
 *   deno test --allow-net --allow-run --allow-env \
 *     supabase/functions/send-contact-email/html_injection_test.ts
 */
const ATTACKER_ORIGIN = "https://attacker.example";
const VISITOR_EMAIL = "visitor@example.com";
const PLACEHOLDER_API_KEY = "placeholder-not-a-real-key";
const PUBLIC_CALLER_TOKEN = "public-anon-placeholder";

const CONTACT_FIRST = `Ann</h1><a href="${ATTACKER_ORIGIN}/confirm">Confirm</a><h1>`;
const CONTACT_LAST = `Lee</p><a href="${ATTACKER_ORIGIN}/name">Lee</a><p>`;
const CONTACT_PHONE = `"><a href="${ATTACKER_ORIGIN}/phone">Call office</a>`;
const CONTACT_MESSAGE =
  `<img src="${ATTACKER_ORIGIN}/pixel.gif" alt="x"><a href="${ATTACKER_ORIGIN}/msg">Review</a>`;

const STYLE_FIRST = `Ann</h1><a href="${ATTACKER_ORIGIN}/style-confirm">Confirm</a><h1>`;
const STYLE_VALUE = `Coastal</strong><a href="${ATTACKER_ORIGIN}/style">Look</a><strong>`;
const STYLE_PHONE = `"><a href="${ATTACKER_ORIGIN}/style-phone">Call</a>`;
const STYLE_MESSAGE = `<a href="${ATTACKER_ORIGIN}/style-note">Note</a>`;

const MAILTO_BREAKOUT =
  `${VISITOR_EMAIL}"></a><a href="${ATTACKER_ORIGIN}/mail">Open</a>`;
const TEL_BREAKOUT = `555"></a><a href="${ATTACKER_ORIGIN}/tel">Dial</a>`;

interface CapturedEmail {
  to: unknown;
  html: string;
  subject: string;
}

const captured: CapturedEmail[] = [];

const options = {
  sanitizeOps: false,
  sanitizeResources: false,
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

/**
 * Real tags whose href or src a mail client would follow.
 * The notice template only uses mailto: and tel: links, so an http(s),
 * protocol-relative, javascript, or data URL is submitted markup.
 * Escaped text such as `&lt;a href="https://..."` is not a tag.
 */
function attackerMarkup(html: string): string[] {
  const hits: string[] = [];
  const tagRe = /<\s*([a-zA-Z][\w:-]*)\b([^>]*)>/g;
  const attrRe = /\b(href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
  let tag: RegExpExecArray | null;
  while ((tag = tagRe.exec(html)) !== null) {
    const attrs = tag[2];
    attrRe.lastIndex = 0;
    let attr: RegExpExecArray | null;
    while ((attr = attrRe.exec(attrs)) !== null) {
      const value = (attr[2] ?? attr[3] ?? attr[4] ?? "").trim().toLowerCase();
      if (
        value.startsWith("https:") ||
        value.startsWith("http:") ||
        value.startsWith("//") ||
        value.startsWith("javascript:") ||
        value.startsWith("data:")
      ) {
        hits.push(tag[0]);
        break;
      }
    }
  }
  return hits;
}

function assertPayloadSafe(email: CapturedEmail, rawSnippets: string[]): void {
  const hits = attackerMarkup(email.html);
  assert(
    hits.length === 0,
    `mail payload for ${JSON.stringify(email.to)} still contains attacker markup: ${
      hits.join(" | ")
    }`,
  );
  for (const snippet of rawSnippets) {
    assert(
      !email.html.includes(snippet),
      `mail payload for ${JSON.stringify(email.to)} still contains the raw field value ${
        JSON.stringify(snippet)
      }`,
    );
  }
}

async function postForm(
  port: number,
  body: Record<string, unknown>,
): Promise<{ status: number; payloads: CapturedEmail[] }> {
  const before = captured.length;
  const response = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Same header shape the published website client sends. Not a signed user session.
      authorization: `Bearer ${PUBLIC_CALLER_TOKEN}`,
      apikey: PUBLIC_CALLER_TOKEN,
    },
    body: JSON.stringify(body),
  });
  await response.text();
  return { status: response.status, payloads: captured.slice(before) };
}

function assertExchangeSafe(
  status: number,
  payloads: CapturedEmail[],
  rawSnippets: string[],
): void {
  if (payloads.length === 0) {
    assert(
      status < 200 || status >= 300,
      "handler reported success but no mail payload was observed",
    );
    return;
  }
  const failures: string[] = [];
  for (const email of payloads) {
    try {
      assertPayloadSafe(email, rawSnippets);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  assert(failures.length === 0, failures.join("\n"));
}

const mock = Deno.serve({ port: 0, hostname: "127.0.0.1" }, async (req) => {
  const url = new URL(req.url);
  if (req.method === "POST" && url.pathname === "/emails") {
    const payload = await req.json();
    captured.push({
      to: payload.to,
      html: typeof payload.html === "string" ? payload.html : "",
      subject: typeof payload.subject === "string" ? payload.subject : "",
    });
    return Response.json({ id: "local-test-id" });
  }
  return new Response("not found", { status: 404 });
});

const mockPort = (mock.addr as Deno.NetAddr).port;
const functionPort = 8000;
const repoRoot = decodeURIComponent(new URL("../../../", import.meta.url).pathname);

const stderrChunks: string[] = [];
const command = new Deno.Command(Deno.execPath(), {
  args: [
    "run",
    "--allow-net",
    "--allow-env",
    "supabase/functions/send-contact-email/index.ts",
  ],
  cwd: repoRoot,
  env: {
    RESEND_API_KEY: PLACEHOLDER_API_KEY,
    RESEND_BASE_URL: `http://127.0.0.1:${mockPort}`,
  },
  stdout: "piped",
  stderr: "piped",
});
const child = command.spawn();

let sawListening: (() => void) | undefined;
const listening = new Promise<void>((resolve) => {
  sawListening = resolve;
});

function pump(stream: ReadableStream<Uint8Array>, sink?: string[]): void {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const read = (): void => {
    reader.read().then(({ value, done }) => {
      if (done) return;
      const text = decoder.decode(value);
      buffered += text;
      sink?.push(text);
      if (buffered.includes("Listening on http://")) {
        sawListening?.();
      }
      read();
    }).catch(() => {});
  };
  read();
}

pump(child.stdout);
pump(child.stderr, stderrChunks);

function stopChild(): void {
  try {
    child.kill("SIGKILL");
  } catch {
    // already exited
  }
}

addEventListener("unload", stopChild);

const started = await Promise.race([
  listening.then(() => true),
  new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 30000)),
  child.status.then(() => false),
]);

if (!started) {
  const detail = stderrChunks.join("");
  stopChild();
  await child.status.catch(() => {});
  throw new Error(`send-contact-email did not start listening\n${detail}`);
}

Deno.test({
  name: "contact form fields are not live html in the office notice or the visitor confirmation",
  ...options,
  async fn() {
    const { status, payloads } = await postForm(functionPort, {
      firstName: CONTACT_FIRST,
      lastName: CONTACT_LAST,
      email: VISITOR_EMAIL,
      phone: CONTACT_PHONE,
      message: CONTACT_MESSAGE,
    });
    assertExchangeSafe(status, payloads, [
      CONTACT_FIRST,
      CONTACT_LAST,
      CONTACT_PHONE,
      CONTACT_MESSAGE,
    ]);
  },
});

Deno.test({
  name: "style-book fields are not live html in the office notice or the visitor confirmation",
  ...options,
  async fn() {
    const { status, payloads } = await postForm(functionPort, {
      firstName: STYLE_FIRST,
      email: VISITOR_EMAIL,
      phone: STYLE_PHONE,
      style: STYLE_VALUE,
      message: STYLE_MESSAGE,
      source: "style-book",
    });
    assertExchangeSafe(status, payloads, [
      STYLE_FIRST,
      STYLE_PHONE,
      STYLE_VALUE,
      STYLE_MESSAGE,
    ]);
  },
});

Deno.test({
  name: "email and phone cannot break out of the mailto and tel links",
  ...options,
  async fn() {
    const { status, payloads } = await postForm(functionPort, {
      firstName: "Ann",
      lastName: "Lee",
      email: MAILTO_BREAKOUT,
      phone: TEL_BREAKOUT,
      message: "Hello",
    });
    assertExchangeSafe(status, payloads, [MAILTO_BREAKOUT, TEL_BREAKOUT]);
  },
});

Deno.test({
  name: "stop the contact-email harness",
  ...options,
  async fn() {
    stopChild();
    await child.status.catch(() => {});
    await mock.shutdown();
  },
});
