import { createClient } from 'npm:@supabase/supabase-js@2'
import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors'
import { TEMPLATES } from '../_shared/transactional-email-templates/registry.ts'
import { enqueueTransactionalEmail } from '../_shared/transactional-email.ts'

// Public endpoint for the website's contact and Style Book forms. Anyone with
// the anon key can call it, so it never lets the caller pick a template or
// recipient: notifications only go to the template's fixed office address,
// and the confirmation to the submitted address carries no caller text.

const MAX_BODY_BYTES = 16 * 1024

// Must match STYLE_OPTIONS in src/pages/Projects.tsx.
const STYLE_OPTIONS = [
  'Oceanfront',
  'Urban Classical',
  'Waterfront Contemporary',
  'Mediterranean',
  'Modern Coastal',
  'Traditional Estate',
  'Bermuda / British Colonial',
  'Anglo-Caribbean / West Indies',
  'Transitional',
  'Regency / Georgian',
  'Yours — something entirely new',
]

const EMAIL_PATTERN =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/
// deno-lint-ignore no-control-regex
const SINGLE_LINE_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/
// deno-lint-ignore no-control-regex
const MULTI_LINE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/

type Inquiry = {
  notificationTemplate: 'contact-notification' | 'style-book-notification'
  confirmationTemplate: 'contact-confirmation' | 'style-book-confirmation'
  email: string
  notificationData: Record<string, string>
  confirmationData: Record<string, string>
}

class ValidationError extends Error {}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function text(
  value: unknown,
  field: string,
  { max, required, multiline = false }: { max: number; required: boolean; multiline?: boolean }
): string {
  if (value === undefined || value === null) value = ''
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string`)
  const trimmed = value.trim()
  if (required && !trimmed) throw new ValidationError(`${field} is required`)
  if (trimmed.length > max) throw new ValidationError(`${field} is too long`)
  if ((multiline ? MULTI_LINE_CONTROL : SINGLE_LINE_CONTROL).test(trimmed)) {
    throw new ValidationError(`${field} contains invalid characters`)
  }
  return trimmed
}

function parseInquiry(body: Record<string, unknown>): Inquiry {
  const email = text(body.email, 'email', { max: 254, required: true }).toLowerCase()
  if (!EMAIL_PATTERN.test(email)) throw new ValidationError('email is invalid')

  const phone = text(body.phone, 'phone', { max: 40, required: false })

  if (body.kind === 'contact') {
    const firstName = text(body.firstName, 'firstName', { max: 100, required: true })
    const lastName = text(body.lastName, 'lastName', { max: 100, required: true })
    const message = text(body.message, 'message', { max: 5000, required: true, multiline: true })
    return {
      notificationTemplate: 'contact-notification',
      confirmationTemplate: 'contact-confirmation',
      email,
      notificationData: { fullName: `${firstName} ${lastName}`, email, phone, message },
      confirmationData: {},
    }
  }

  if (body.kind === 'style-book') {
    const fullName = text(body.name, 'name', { max: 100, required: true })
    const note = text(body.note, 'note', { max: 600, required: false, multiline: true })
    const style = STYLE_OPTIONS.find((option) => option === body.style)
    if (!style) throw new ValidationError('style is invalid')
    return {
      notificationTemplate: 'style-book-notification',
      confirmationTemplate: 'style-book-confirmation',
      email,
      notificationData: { fullName, email, phone, style, message: note },
      confirmationData: { style },
    }
  }

  throw new ValidationError('kind is invalid')
}

function clientIp(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  return forwarded || req.headers.get('cf-connecting-ip') || req.headers.get('x-real-ip') || 'unknown'
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !supabaseServiceKey) {
    console.error('Missing required environment variables')
    return json({ error: 'Server configuration error' }, 500)
  }

  let inquiry: Inquiry
  try {
    const raw = await req.text()
    if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
      return json({ error: 'Request body too large' }, 413)
    }
    const body = JSON.parse(raw)
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ValidationError('Request body must be an object')
    }
    inquiry = parseInquiry(body as Record<string, unknown>)
  } catch (error) {
    const message = error instanceof ValidationError ? error.message : 'Invalid JSON in request body'
    return json({ error: message }, 400)
  }

  const notificationTemplate = TEMPLATES[inquiry.notificationTemplate]
  const confirmationTemplate = TEMPLATES[inquiry.confirmationTemplate]
  if (!notificationTemplate?.to || !confirmationTemplate) {
    console.error('Inquiry templates are misconfigured', inquiry.notificationTemplate)
    return json({ error: 'Server configuration error' }, 500)
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  const { data: allowed, error: claimError } = await supabase.rpc('claim_inquiry_slot', {
    p_ip_hash: await sha256Hex(clientIp(req)),
    p_email: inquiry.email,
  })
  if (claimError) {
    console.error('Inquiry rate limit check failed — refusing to send', { error: claimError })
    return json({ error: 'Failed to accept inquiry' }, 500)
  }
  if (allowed !== true) {
    return json({ error: 'Too many requests' }, 429)
  }

  const notified = await enqueueTransactionalEmail(supabase, {
    templateName: inquiry.notificationTemplate,
    template: notificationTemplate,
    recipient: notificationTemplate.to,
    templateData: inquiry.notificationData,
  })
  if (!notified.ok && !notified.suppressed) {
    return json({ error: notified.error }, notified.status)
  }

  const confirmed = await enqueueTransactionalEmail(supabase, {
    templateName: inquiry.confirmationTemplate,
    template: confirmationTemplate,
    recipient: inquiry.email,
    templateData: inquiry.confirmationData,
  })
  if (!confirmed.ok && !confirmed.suppressed) {
    return json({ error: confirmed.error }, confirmed.status)
  }

  return json({ success: true }, 200)
})
