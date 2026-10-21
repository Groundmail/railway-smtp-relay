import { SMTPServer } from 'smtp-server'
import { simpleParser } from 'mailparser'
import { Groundmail, GroundmailError } from 'groundmail'
import { toSendParams, RelayError } from './convert.js'

const apiKey = process.env.GROUNDMAIL_API_KEY?.trim()
const port = Number(process.env.SMTP_PORT || 2525)
const host = process.env.SMTP_HOST || '::'
const username = process.env.SMTP_USERNAME || 'groundmail'
const password = process.env.SMTP_PASSWORD || ''
const maxSize = Number(process.env.MAX_MESSAGE_BYTES || 40 * 1024 * 1024)

if (!apiKey) {
  console.error('GROUNDMAIL_API_KEY is not set. Create one at https://app.groundmail.dev/api-keys')
  process.exit(1)
}
if (!password) {
  console.warn('SMTP_PASSWORD is not set: the relay accepts mail without a login. Only do this on a private network.')
}

const client = new Groundmail(apiKey, process.env.GROUNDMAIL_API_URL ? { baseUrl: process.env.GROUNDMAIL_API_URL } : undefined)

function smtpError(message, responseCode) {
  const err = new Error(message)
  err.responseCode = responseCode
  return err
}

const server = new SMTPServer({
  name: process.env.SMTP_HOSTNAME || 'railway-smtp-relay',
  banner: 'Groundmail SMTP relay',
  size: maxSize,
  authOptional: !password,
  allowInsecureAuth: true,
  // Traffic stays on Railway's private network, so there's no certificate to offer.
  disabledCommands: ['STARTTLS'],
  onAuth(auth, _session, callback) {
    if (password && auth.username === username && auth.password === password) {
      return callback(null, { user: auth.username })
    }
    callback(smtpError('Invalid username or password', 535))
  },
  onData(stream, session, callback) {
    simpleParser(stream)
      .then(async (parsed) => {
        if (stream.sizeExceeded) throw smtpError('Message is too large', 552)
        const params = toSendParams(parsed, session.envelope)
        const result = await client.emails.send(params)
        console.log(`sent ${result.id} to ${session.envelope.rcptTo.length} recipient(s)`)
        callback(null, `Queued as ${result.id}`)
      })
      .catch((err) => {
        if (err instanceof RelayError) return callback(smtpError(err.message, err.responseCode))
        if (err instanceof GroundmailError) {
          console.error(`Groundmail rejected the message (${err.status}): ${err.message}`)
          // 4xx from the API means the message itself won't succeed on retry, except rate limits.
          const permanent = err.status >= 400 && err.status < 500 && err.status !== 429
          return callback(smtpError(err.message, permanent ? 550 : 451))
        }
        console.error('Relay error:', err)
        callback(smtpError('Temporary failure, try again', 451))
      })
  },
})

server.on('error', (err) => console.error('SMTP server error:', err.message))
server.listen(port, host, () => {
  console.log(`Groundmail SMTP relay listening on port ${port}${password ? ` (login: ${username})` : ''}`)
})

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
