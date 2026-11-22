// Inquiry email and phone values end up inside mailto: and tel: links in the
// office notifications. Only accept a single bare address / phone number so a
// submitter cannot smuggle extra recipients or header fields (?bcc=, ?body=,
// commas, angle brackets, whitespace) into the link staff click to reply.

const EMAIL_PATTERN =
  /^[A-Za-z0-9._'+-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/
const PHONE_PATTERN = /^\+?[0-9 ().-]+$/

export function plainEmail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const email = value.trim()
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) return undefined
  return email
}

export function plainPhone(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const phone = value.trim()
  if (phone.length > 40 || !PHONE_PATTERN.test(phone)) return undefined
  const digits = phone.replace(/[^0-9]/g, '').length
  if (digits < 7 || digits > 15) return undefined
  return phone
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
}

export type InquiryContactCheck =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string }

// Validates the optional `email` and `phone` fields of template data and
// returns a copy holding the checked (trimmed) values.
export function checkInquiryContact(data: Record<string, unknown>): InquiryContactCheck {
  const checked: Record<string, unknown> = { ...data }

  if (isBlank(data.email)) {
    delete checked.email
  } else {
    const email = plainEmail(data.email)
    if (!email) return { ok: false, error: 'templateData.email must be a single plain email address' }
    checked.email = email
  }

  if (isBlank(data.phone)) {
    delete checked.phone
  } else {
    const phone = plainPhone(data.phone)
    if (!phone) return { ok: false, error: 'templateData.phone must contain only digits and standard separators' }
    checked.phone = phone
  }

  return { ok: true, data: checked }
}
