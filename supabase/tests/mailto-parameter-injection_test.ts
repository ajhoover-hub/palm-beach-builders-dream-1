/**
 * Spec for inquiry mailto/tel parameter injection.
 *
 * These tests call the real send-transactional-email handler and the real
 * send-contact-email handler. They pass while a plain address is queued to
 * the template's fixed office recipient, and they fail while an address or
 * phone that carries mailto/tel parameters is still accepted.
 *
 * Run from the repository root:
 *   deno test -A --no-check --node-modules-dir=none supabase/tests/mailto-parameter-injection_test.ts
 */
import assert from "node:assert/strict"
import { TEMPLATES } from "../functions/_shared/transactional-email-templates/registry.ts"

const VISITOR = "visitor@example.com"
const VISITOR_PLUS = "visitor+project@example.com"
const OUTSIDE = "outside.party@example.com"
const PHONE = "(561) 555-0100"
const PHONE_PLUS = "+1 561-555-0100"
const PHONE_DOTS = "561.555.0100"
const SERVICE_KEY = "test-only-not-a-credential"

type Mutation = { method: string; path: string; body: unknown }
type Enqueued = {
  to?: string
  html?: string
  text?: string
  subject?: string
}

const mutations: Mutation[] = []
const enqueued: Enqueued[] = []
const resendCalls: { url: string; body: Record<string, unknown> }[] = []
let tokens: Record<string, unknown>[] = []

function resetStores() {
  mutations.length = 0
  enqueued.length = 0
  resendCalls.length = 0
  tokens = []
}

function json(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  })
}

function postgrest(req: Request): Promise<Response> | Response {
  const url = new URL(req.url)
  const path = url.pathname
  if (req.method === "GET" && path.endsWith("/suppressed_emails")) {
    return json("[]")
  }
  if (req.method === "GET" && path.endsWith("/email_unsubscribe_tokens")) {
    const filter = url.searchParams.get("email") ?? ""
    const email = filter.replace(/^eq\./, "")
    const rows = email ? tokens.filter((row) => row.email === email) : tokens
    return json(JSON.stringify(rows))
  }
  if (req.method === "GET" || req.method === "HEAD") {
    return json("[]")
  }

  return req.text().then((text) => {
    const body = text ? JSON.parse(text) : null
    if (path.startsWith("/rest/")) {
      mutations.push({ method: req.method, path, body })
    }
    if (path.endsWith("/email_unsubscribe_tokens")) {
      const row = body as Record<string, unknown>
      if (!tokens.some((existing) => existing.email === row.email)) {
        tokens.push(row)
      }
      return new Response(null, { status: 201 })
    }
    if (path.endsWith("/email_send_log")) {
      return new Response(null, { status: 201 })
    }
    if (path.endsWith("/rpc/enqueue_email")) {
      enqueued.push((body as { payload: Enqueued }).payload)
      return json("1")
    }
    return new Response(null, { status: 201 })
  })
}

function decodeAttribute(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
}

function hrefs(html: string): string[] {
  return [...html.matchAll(/href\s*=\s*"([^"]*)"/gi)].map((match) =>
    decodeAttribute(match[1])
  )
}

function describeTransactional(status: number, body: string): string {
  const links = enqueued.flatMap((payload) => hrefs(String(payload.html ?? "")))
  const recipients = enqueued.map((payload) => payload.to)
  const writes = mutations.map((mutation) => `${mutation.method} ${mutation.path}`)
  return `status=${status} body=${body} hrefs=${JSON.stringify(links)} to=${JSON.stringify(recipients)} writes=${JSON.stringify(writes)}`
}

function describeContact(status: number, body: string): string {
  const links = resendCalls.flatMap((call) => hrefs(String(call.body.html ?? "")))
  const recipients = resendCalls.map((call) => call.body.to)
  return `status=${status} body=${body} hrefs=${JSON.stringify(links)} to=${JSON.stringify(recipients)} sends=${resendCalls.length}`
}

const ATTACKS: { name: string; email: string; phone?: string }[] = [
  {
    name: "bcc, subject, and body parameters",
    email: `${VISITOR}?bcc=${OUTSIDE}&subject=Pricing&body=Please%20confirm%20the%20quote`,
    phone: PHONE,
  },
  {
    name: "cc parameter",
    email: `${VISITOR}?cc=${OUTSIDE}`,
    phone: PHONE,
  },
  {
    name: "comma-separated second recipient",
    email: `${VISITOR},${OUTSIDE}`,
    phone: PHONE,
  },
  {
    name: "angle brackets",
    email: `Visitor <${VISITOR}>`,
    phone: PHONE,
  },
  {
    name: "whitespace",
    email: `${VISITOR} ${OUTSIDE}`,
    phone: PHONE,
  },
  {
    name: "newline",
    email: `${VISITOR}\nbcc:${OUTSIDE}`,
    phone: PHONE,
  },
  {
    name: "phone query",
    email: VISITOR,
    phone: "+1 (561) 555-0100?body=call",
  },
  {
    name: "phone parameter",
    email: VISITOR,
    phone: "+15615550100;ext=1",
  },
]

let transactional: (req: Request) => Promise<Response> | Response
let contact: (req: Request) => Promise<Response> | Response
let contactRecipient = ""

const realFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = async (input: Request | URL | string, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input)
  if (url.startsWith("https://api.resend.com/")) {
    const raw = init?.body == null ? "" : String(init.body)
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
    resendCalls.push({ url, body })
    return json(JSON.stringify({ id: "test-message" }))
  }
  return realFetch(input, init)
}

const realServe = Deno.serve
const mock = realServe({ port: 0, hostname: "127.0.0.1", onListen() {} }, (req) =>
  postgrest(req)
)
const mockPort = (mock.addr as Deno.NetAddr).port
Deno.env.set("SUPABASE_URL", `http://127.0.0.1:${mockPort}`)
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY)
Deno.env.set("RESEND_API_KEY", SERVICE_KEY)

Deno.serve = ((arg1: unknown, arg2?: unknown) => {
  const handler = typeof arg1 === "function" ? arg1 : arg2
  transactional = handler as (req: Request) => Promise<Response> | Response
  return {
    finished: Promise.resolve(),
    async shutdown() {},
    addr: { hostname: "127.0.0.1", port: 0, transport: "tcp" },
    ref() {},
    unref() {},
  }
}) as typeof Deno.serve

await import("../functions/send-transactional-email/index.ts")
if (!transactional) {
  throw new Error("send-transactional-email did not register a request handler")
}

const contactSourceUrl = new URL("../functions/send-contact-email/index.ts", import.meta.url)
const contactSource = await Deno.readTextFile(contactSourceUrl)
const recipientMatch = contactSource.match(/to:\s*\[\s*"([^"]+)"\s*\]/)
if (!recipientMatch) {
  throw new Error("send-contact-email has no fixed recipient")
}
contactRecipient = recipientMatch[1]
const patchedContact = contactSource.replace(
  "serve(handler);",
  "globalThis.__sendContactHandler = handler;",
)
if (patchedContact === contactSource) {
  throw new Error("could not detach send-contact-email listener")
}
const patchedPath = await Deno.makeTempFile({ prefix: "send-contact-email-", suffix: ".ts" })
await Deno.writeTextFile(patchedPath, patchedContact)
await import(patchedPath)
contact = (globalThis as { __sendContactHandler?: (req: Request) => Promise<Response> | Response })
  .__sendContactHandler as (req: Request) => Promise<Response> | Response
if (!contact) {
  throw new Error("send-contact-email handler was not captured")
}

let chain = Promise.resolve()
function serial(name: string, fn: () => Promise<void>) {
  Deno.test({ name, sanitizeOps: false, sanitizeResources: false }, () => {
    const run = chain.then(fn)
    chain = run.then(() => {}, () => {})
    return run
  })
}

async function postTransactional(body: Record<string, unknown>) {
  resetStores()
  const response = await transactional(
    new Request("http://localhost/functions/v1/send-transactional-email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SERVICE_KEY}`,
      },
      body: JSON.stringify(body),
    }),
  )
  const text = await response.text()
  return { status: response.status, body: text }
}

async function postContact(body: Record<string, unknown>) {
  resetStores()
  const response = await contact(
    new Request("http://localhost/functions/v1/send-contact-email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SERVICE_KEY}`,
      },
      body: JSON.stringify(body),
    }),
  )
  const text = await response.text()
  return { status: response.status, body: text }
}

function assertPlainLinks(html: string, email: string, phone?: string) {
  const links = hrefs(html)
  const mailto = links.filter((link) => link.startsWith("mailto:"))
  const tel = links.filter((link) => link.startsWith("tel:"))
  assert.deepEqual(mailto, [`mailto:${email}`], `mailto links ${JSON.stringify(links)}`)
  if (phone) {
    assert.deepEqual(tel, [`tel:${phone}`], `tel links ${JSON.stringify(links)}`)
  } else {
    assert.deepEqual(tel, [], `tel links ${JSON.stringify(links)}`)
  }
  assert.equal(html.includes(OUTSIDE), false)
  assert.equal(links.some((link) => link.includes("?") || link.includes(",")), false)
}

function assertRejectedTransactional(status: number, body: string, label: string) {
  const detail = describeTransactional(status, body)
  assert.ok(status >= 400 && status < 500, `${label}: expected rejection. ${detail}`)
  assert.equal(enqueued.length, 0, `${label}: email was queued. ${detail}`)
  assert.equal(mutations.length, 0, `${label}: wrote email state before refusing. ${detail}`)
  assert.equal(resendCalls.length, 0, `${label}: called the mail API. ${detail}`)
}

function assertRejectedContact(status: number, body: string, label: string) {
  const detail = describeContact(status, body)
  assert.ok(status >= 400 && status < 500, `${label}: expected rejection. ${detail}`)
  assert.equal(resendCalls.length, 0, `${label}: mail was submitted. ${detail}`)
  assert.equal(mutations.length, 0, `${label}: wrote email state before refusing. ${detail}`)
}

serial("contact notification accepts one plain address and queues it to the office", async () => {
  const office = TEMPLATES["contact-notification"].to
  const result = await postTransactional({
    templateName: "contact-notification",
    recipientEmail: OUTSIDE,
    templateData: {
      fullName: "Jane Doe",
      email: VISITOR,
      phone: PHONE,
      message: "A note about the project.",
    },
  })
  assert.equal(result.status, 200, describeTransactional(result.status, result.body))
  assert.equal(enqueued.length, 1)
  assert.equal(enqueued[0].to, office)
  assert.notEqual(enqueued[0].to, OUTSIDE)
  assertPlainLinks(String(enqueued[0].html), VISITOR, PHONE)
  assert.equal(String(enqueued[0].text).includes(OUTSIDE), false)
  assert.equal(String(enqueued[0].text).includes("?"), false)
})

serial("style book notification accepts dotted phone numbers and plus-addressed mail", async () => {
  const office = TEMPLATES["style-book-notification"].to
  const result = await postTransactional({
    template_name: "style-book-notification",
    recipient_email: OUTSIDE,
    templateData: {
      fullName: "Jane Doe",
      email: VISITOR_PLUS,
      phone: PHONE_DOTS,
      style: "Anglo-Caribbean",
      message: "A note.",
    },
  })
  assert.equal(result.status, 200, describeTransactional(result.status, result.body))
  assert.equal(enqueued.length, 1)
  assert.equal(enqueued[0].to, office)
  assertPlainLinks(String(enqueued[0].html), VISITOR_PLUS, PHONE_DOTS)
})

serial("contact notification accepts a plain address with no phone", async () => {
  const result = await postTransactional({
    templateName: "contact-notification",
    templateData: { fullName: "Jane Doe", email: VISITOR, message: "Hello" },
  })
  assert.equal(result.status, 200, describeTransactional(result.status, result.body))
  assert.equal(enqueued.length, 1)
  assert.equal(enqueued[0].to, TEMPLATES["contact-notification"].to)
  assertPlainLinks(String(enqueued[0].html), VISITOR)
})

serial("style book notification accepts an international phone", async () => {
  const result = await postTransactional({
    templateName: "style-book-notification",
    templateData: {
      fullName: "Jane Doe",
      email: VISITOR,
      phone: PHONE_PLUS,
      style: "Coastal",
    },
  })
  assert.equal(result.status, 200, describeTransactional(result.status, result.body))
  assertPlainLinks(String(enqueued[0].html), VISITOR, PHONE_PLUS)
})

for (const attack of ATTACKS) {
  for (const templateName of ["contact-notification", "style-book-notification"] as const) {
    serial(`${templateName} rejects ${attack.name}`, async () => {
      const result = await postTransactional({
        templateName,
        recipientEmail: OUTSIDE,
        templateData: {
          fullName: "Jane Doe",
          email: attack.email,
          phone: attack.phone,
          style: "Anglo-Caribbean",
          message: "A note about the project.",
        },
      })
      assertRejectedTransactional(result.status, result.body, `${templateName} ${attack.name}`)
    })
  }
}

serial("send-contact-email accepts one plain address and sends it to the fixed office", async () => {
  const result = await postContact({
    firstName: "Jane",
    lastName: "Doe",
    email: VISITOR,
    phone: PHONE,
    message: "A note about the project.",
  })
  assert.equal(result.status, 200, describeContact(result.status, result.body))
  assert.equal(resendCalls.length, 2, describeContact(result.status, result.body))
  const team = resendCalls[0].body
  assert.deepEqual(team.to, [contactRecipient])
  assertPlainLinks(String(team.html), VISITOR, PHONE)
  assert.equal(String(team.html).includes(OUTSIDE), false)
})

serial("send-contact-email accepts a style book inquiry with a plain address", async () => {
  const result = await postContact({
    firstName: "Jane",
    email: VISITOR_PLUS,
    phone: PHONE_PLUS,
    style: "Anglo-Caribbean",
    source: "style-book",
  })
  assert.equal(result.status, 200, describeContact(result.status, result.body))
  assert.deepEqual(resendCalls[0].body.to, [contactRecipient])
  assertPlainLinks(String(resendCalls[0].body.html), VISITOR_PLUS, PHONE_PLUS)
})

for (const attack of ATTACKS) {
  serial(`send-contact-email rejects ${attack.name}`, async () => {
    const result = await postContact({
      firstName: "Jane",
      lastName: "Doe",
      email: attack.email,
      phone: attack.phone,
      message: "A note about the project.",
    })
    assertRejectedContact(result.status, result.body, `send-contact-email ${attack.name}`)
  })
}

serial("shutdown local postgrest stand-in", async () => {
  await mock.shutdown()
})
