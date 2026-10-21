// Turns a parsed SMTP message (mailparser) plus its SMTP envelope into a
// Groundmail send request.

const SKIPPED_HEADERS = new Set([
  'from',
  'to',
  'cc',
  'bcc',
  'reply-to',
  'subject',
  'date',
  'message-id',
  'mime-version',
  'received',
  'return-path',
  'dkim-signature',
  'x-mailer',
])

function addressList(field) {
  if (!field) return []
  const groups = Array.isArray(field) ? field : [field]
  return groups.flatMap((group) => group.value ?? [])
}

function formatAddress(addr) {
  const email = addr.address?.trim()
  if (!email) return ''
  const name = addr.name?.trim()
  return name ? `${name} <${email}>` : email
}

function bare(addr) {
  return addr.address?.trim().toLowerCase() ?? ''
}

/**
 * @param {import('mailparser').ParsedMail} parsed
 * @param {{ mailFrom?: { address: string } | false, rcptTo: Array<{ address: string }> }} envelope
 */
export function toSendParams(parsed, envelope) {
  const fromHeader = addressList(parsed.from)[0]
  const from = fromHeader ? formatAddress(fromHeader) : envelope.mailFrom?.address
  if (!from) throw new RelayError('Message has no From address.', 550)

  const toHeader = addressList(parsed.to)
  const ccHeader = addressList(parsed.cc)
  const envelopeRcpts = envelope.rcptTo.map((r) => r.address.trim().toLowerCase())
  const rcptSet = new Set(envelopeRcpts)

  // The envelope decides who gets the message. Header recipients that are
  // also in the envelope keep their display names; envelope recipients that
  // aren't in To or Cc were Bcc'd.
  const to = toHeader.filter((a) => rcptSet.has(bare(a))).map(formatAddress)
  const cc = ccHeader.filter((a) => rcptSet.has(bare(a))).map(formatAddress)
  const shown = new Set([...toHeader, ...ccHeader].map(bare))
  const bcc = [...new Set(envelopeRcpts.filter((r) => !shown.has(r)))]

  if (!to.length && !cc.length && !bcc.length) {
    throw new RelayError('Message has no recipients.', 550)
  }
  // The API needs at least one To; promote the first recipient when a client
  // only used Cc or Bcc.
  if (!to.length) to.push((cc.length ? cc : bcc).shift())

  const html = typeof parsed.html === 'string' && parsed.html ? parsed.html : undefined
  const text = parsed.text || undefined
  if (!html && !text) throw new RelayError('Message has no body.', 550)

  const params = { from, to: to.length === 1 ? to[0] : to }
  if (parsed.subject) params.subject = parsed.subject
  if (html) params.html = html
  if (text) params.text = text
  if (cc.length) params.cc = cc
  if (bcc.length) params.bcc = bcc

  const replyTo = addressList(parsed.replyTo).map(formatAddress).filter(Boolean)
  if (replyTo.length) params.replyTo = replyTo.length === 1 ? replyTo[0] : replyTo

  if (parsed.attachments?.length) {
    params.attachments = parsed.attachments.map((att) => ({
      filename: att.filename || 'attachment',
      contentType: att.contentType || 'application/octet-stream',
      content: att.content.toString('base64'),
      ...(att.contentId && att.related ? { contentId: att.contentId.replace(/^<|>$/g, '') } : {}),
    }))
  }

  const headers = {}
  for (const line of parsed.headerLines ?? []) {
    const key = line.key.toLowerCase()
    if (SKIPPED_HEADERS.has(key) || key.startsWith('content-') || key.startsWith('x-groundmail-')) continue
    const colon = line.line.indexOf(':')
    const name = line.line.slice(0, colon).trim()
    const value = line.line.slice(colon + 1).replace(/\r?\n\s+/g, ' ').trim()
    if (value) headers[name] = value
  }
  if (Object.keys(headers).length) params.headers = headers

  const tag = parsed.headers.get('x-groundmail-tag')
  if (typeof tag === 'string' && tag.trim()) {
    const [name, value] = tag.includes('=') ? tag.split('=', 2) : ['tag', tag]
    if (name.trim() && value.trim()) params.tags = [{ name: name.trim(), value: value.trim() }]
  }
  const idem = parsed.headers.get('x-groundmail-idempotency-key')
  if (typeof idem === 'string' && idem.trim()) params.idempotencyKey = idem.trim()

  return params
}

export class RelayError extends Error {
  constructor(message, responseCode) {
    super(message)
    this.responseCode = responseCode
  }
}
