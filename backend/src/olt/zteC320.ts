import { Client } from 'ssh2'
import type { OnuStatus } from '../generated/prisma/client'

export interface OltConnectionConfig {
  host: string
  port: number
  username: string
  password: string
  readyTimeoutMs: number
  commandTimeoutMs: number
}

export interface OltCommandResult {
  host: string
  commands: string[]
  output: string
}

export interface ParsedOnuDetail {
  onuInterface: string
  onuStatus: OnuStatus
  onuRxPower: number | null
  rawStatusText: string | null
  rawOutput: string
}

interface ParsedOnuInterfaceParts {
  onuInterface: string
  oltInterface: string
  pon: string
  onuId: string
}

export function getOltConfigFromEnv(): OltConnectionConfig {
  const host = process.env.OLT_HOST?.trim()
  const username = process.env.OLT_USERNAME?.trim()
  const password = process.env.OLT_PASSWORD ?? ''

  if (!host) {
    throw new Error('OLT_HOST belum diatur di file .env')
  }

  if (!username) {
    throw new Error('OLT_USERNAME belum diatur di file .env')
  }

  if (!password) {
    throw new Error('OLT_PASSWORD belum diatur di file .env')
  }

  return {
    host,
    username,
    password,
    port: Number(process.env.OLT_PORT || 22),
    readyTimeoutMs: Number(process.env.OLT_READY_TIMEOUT_MS || 15000),
    commandTimeoutMs: Number(process.env.OLT_COMMAND_TIMEOUT_MS || 35000),
  }
}

export async function testOltConnection(config = getOltConfigFromEnv()) {
  const result = await runZteC320Commands(['show clock'], config)

  return {
    host: config.host,
    port: config.port,
    username: config.username,
    output: result.output,
  }
}

export async function checkZteC320Onu(
  onuInterface: string,
  config = getOltConfigFromEnv(),
): Promise<ParsedOnuDetail> {
  const parts = parseOnuInterfaceParts(onuInterface)

  // Pada sebagian ZTE C320, command detail-info tidak aktif/berbeda sehingga muncul:
  // %Error 20202: Invalid input detected at '^' marker.Invalid parameter
  // Karena itu kita jalankan beberapa command aman dalam 1 sesi dan parser akan memilih
  // data yang berhasil dibaca.
  const commands = [
    `show gpon onu state ${parts.oltInterface}`,
    `show pon power attenuation ${parts.onuInterface}`,
    `show gpon onu detail-info ${parts.onuInterface}`,
  ]

  const result = await runZteC320Commands(commands, config)

  return parseOnuDetailOutput(parts.onuInterface, result.output)
}

export async function runZteC320Commands(
  commands: string[],
  config = getOltConfigFromEnv(),
): Promise<OltCommandResult> {
  return new Promise((resolve, reject) => {
    const connection = new Client()
    let output = ''
    let settled = false

    const cleanup = () => {
      connection.removeAllListeners()
      connection.end()
    }

    const fail = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }

    const succeed = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve({
        host: config.host,
        commands,
        output: sanitizeOltOutput(output),
      })
    }

    const timeout = setTimeout(() => {
      fail(new Error(`Timeout menjalankan command OLT setelah ${config.commandTimeoutMs}ms.`))
    }, config.commandTimeoutMs)

    connection
      .on('ready', () => {
        connection.shell({ term: 'vt100' }, (error, stream) => {
          if (error) {
            clearTimeout(timeout)
            fail(error)
            return
          }

          stream.on('data', (data: Buffer) => {
            output += data.toString('utf8')
          })

          stream.stderr.on('data', (data: Buffer) => {
            output += data.toString('utf8')
          })

          stream.on('close', () => {
            clearTimeout(timeout)
            succeed()
          })

          const commandQueue = [
            'terminal length 0',
            ...commands,
            'exit',
            'yes',
          ]

          commandQueue.forEach((command, index) => {
            setTimeout(() => {
              if (!settled) {
                stream.write(`${command}\n`)
              }
            }, 450 + index * 900)
          })

          setTimeout(() => {
            clearTimeout(timeout)
            succeed()
          }, Math.min(config.commandTimeoutMs - 500, 450 + commandQueue.length * 1100 + 2500))
        })
      })
      .on('keyboard-interactive', (_name, _instructions, _instructionsLang, prompts, finish) => {
        finish(prompts.map(() => config.password))
      })
      .on('error', (error) => {
        clearTimeout(timeout)
        fail(error)
      })
      .on('timeout', () => {
        clearTimeout(timeout)
        fail(new Error('Timeout saat konek ke OLT.'))
      })
      .connect({
        host: config.host,
        port: config.port,
        username: config.username,
        password: config.password,
        readyTimeout: config.readyTimeoutMs,
        keepaliveInterval: 10000,
        keepaliveCountMax: 3,
        tryKeyboard: true,
        hostVerifier: () => true,
        algorithms: {
          kex: [
            'curve25519-sha256',
            'curve25519-sha256@libssh.org',
            'ecdh-sha2-nistp256',
            'ecdh-sha2-nistp384',
            'ecdh-sha2-nistp521',
            'diffie-hellman-group-exchange-sha256',
            'diffie-hellman-group14-sha256',
            'diffie-hellman-group14-sha1',
            'diffie-hellman-group-exchange-sha1',
            'diffie-hellman-group1-sha1',
          ],
          serverHostKey: [
            'ssh-ed25519',
            'ecdsa-sha2-nistp256',
            'ecdsa-sha2-nistp384',
            'ecdsa-sha2-nistp521',
            'rsa-sha2-512',
            'rsa-sha2-256',
            'ssh-rsa',
            'ssh-dss',
          ],
          cipher: [
            'aes128-gcm',
            'aes128-gcm@openssh.com',
            'aes256-gcm',
            'aes256-gcm@openssh.com',
            'aes128-ctr',
            'aes192-ctr',
            'aes256-ctr',
            'aes128-cbc',
            'aes192-cbc',
            'aes256-cbc',
            '3des-cbc',
          ],
          hmac: [
            'hmac-sha2-256',
            'hmac-sha2-512',
            'hmac-sha1',
            'hmac-md5',
          ],
        },
        debug: process.env.OLT_SSH_DEBUG === 'true' ? console.log : undefined,
      })
  })
}

export function normalizeOnuInterface(value: string) {
  return parseOnuInterfaceParts(value).onuInterface
}

function parseOnuInterfaceParts(value: string): ParsedOnuInterfaceParts {
  const text = String(value || '').trim()

  if (!text) {
    throw new Error('ONU interface wajib diisi. Contoh: gpon-onu_1/1/1:11')
  }

  const normalized = text.toLowerCase().startsWith('gpon-onu_') ? text : `gpon-onu_${text}`
  const match = normalized.match(/^gpon-onu_(\d+\/\d+\/\d+):(\d+)$/i)

  if (!match?.[1] || !match?.[2]) {
    throw new Error('Format ONU interface tidak valid. Contoh: gpon-onu_1/1/1:11 atau 1/1/1:11')
  }

  return {
    onuInterface: normalized,
    oltInterface: `gpon-olt_${match[1]}`,
    pon: match[1],
    onuId: match[2],
  }
}

export function parseOnuDetailOutput(
  onuInterface: string,
  output: string,
): ParsedOnuDetail {
  const normalizedInterface = normalizeOnuInterface(onuInterface)
  const parts = parseOnuInterfaceParts(normalizedInterface)
  const normalizedOutput = output.replace(/\r/g, '')
  const lowerOutput = normalizedOutput.toLowerCase()
  const rxPower = parseRxPower(normalizedOutput, parts)
  const rawStatusText = parseRawStatusText(normalizedOutput, parts)

  let onuStatus: OnuStatus = 'UNKNOWN'

  if (/dying[\s_-]*gasp/i.test(rawStatusText || normalizedOutput)) {
    onuStatus = 'DYING_GASP'
  } else if (/\blos\b|loss of signal/i.test(rawStatusText || normalizedOutput)) {
    onuStatus = 'LOS'
  } else if (/offline|off-line/i.test(rawStatusText || normalizedOutput)) {
    onuStatus = 'OFFLINE'
  } else if (/working|online|ready|operation\s+state\s*:\s*up|phase\s+state\s*:\s*(working|ready)/i.test(rawStatusText || normalizedOutput)) {
    onuStatus = 'ONLINE'
  } else if (/disable|disabled|deactive|deactivate/i.test(rawStatusText || normalizedOutput)) {
    onuStatus = 'OFFLINE'
  } else if (lowerOutput.includes('does not exist') || lowerOutput.includes('invalid parameter')) {
    onuStatus = 'UNKNOWN'
  }

  return {
    onuInterface: normalizedInterface,
    onuStatus,
    onuRxPower: rxPower,
    rawStatusText,
    rawOutput: normalizedOutput,
  }
}

function parseRxPower(output: string, parts?: ParsedOnuInterfaceParts): number | null {
  const cleaned = output.replace(/\r/g, '')

  // Format ZTE C320 dari command:
  // show pon power attenuation gpon-onu_1/2/3:2
  // up      Rx :-25.157(dbm)      Tx:2.422(dbm)        27.579(dB)
  // down    Tx :6.183(dbm)        Rx:-22.008(dbm)      28.191(dB)
  // Yang biasanya dibutuhkan untuk sisi pelanggan/ONU adalah nilai Rx pada baris "down".
  const downRxMatch = cleaned.match(/\bdown\b[\s\S]*?\bRx\s*:\s*(-?\d+(?:\.\d+)?)\s*\(\s*dbm\s*\)/i)
  if (downRxMatch?.[1]) {
    const value = Number(downRxMatch[1])
    if (Number.isFinite(value)) return value
  }

  // Fallback: sebagian firmware menulis ONU Rx dengan label lain.
  const patterns = [
    /rx\s+optical\s+power[^-\d]*(-?\d+(?:\.\d+)?)/i,
    /receive\s+power[^-\d]*(-?\d+(?:\.\d+)?)/i,
    /rx\s+power[^-\d]*(-?\d+(?:\.\d+)?)/i,
    /onu\s+rx[^-\d]*(-?\d+(?:\.\d+)?)/i,
    /downstream\s+power[^-\d]*(-?\d+(?:\.\d+)?)/i,
  ]

  for (const pattern of patterns) {
    const match = cleaned.match(pattern)
    if (!match?.[1]) continue

    const value = Number(match[1])
    if (Number.isFinite(value)) return value
  }

  if (parts) {
    const tableRow = findLineForOnu(cleaned, parts)
    if (tableRow) {
      const dbmMatch = tableRow.match(/(-?\d+(?:\.\d+)?)\s*(?:\(?\s*dbm\s*\)?|dBm)/i)
      if (dbmMatch?.[1]) {
        const value = Number(dbmMatch[1])
        if (Number.isFinite(value)) return value
      }
    }
  }

  return null
}

function parseRawStatusText(output: string, parts?: ParsedOnuInterfaceParts): string | null {
  const cleaned = output.replace(/\r/g, '')

  if (parts) {
    const tableRow = findLineForOnu(cleaned, parts)
    if (tableRow) {
      // Contoh output ZTE C320:
      // 1/2/3:2     enable       enable      working      1(GPON)
      // 1/2/3:28    enable       disable     OffLine      1(GPON)
      const words = tableRow.trim().split(/\s+/)
      const statusWord = words.find((word) => /^(working|online|ready|offline|off-line|los|dying-gasp|disable|disabled)$/i.test(word))
      if (statusWord) return statusWord
      return tableRow.trim().slice(0, 160)
    }
  }

  const patterns = [
    /phase\s+state\s*:\s*(.+)/i,
    /onu\s+status\s*:\s*(.+)/i,
    /operation\s+state\s*:\s*(.+)/i,
    /omcc\s+state\s*:\s*(.+)/i,
    /state\s*:\s*(.+)/i,
  ]

  for (const pattern of patterns) {
    const match = cleaned.match(pattern)
    if (!match?.[1]) continue

    return match[1].trim().slice(0, 120)
  }

  return null
}

function findLineForOnu(output: string, parts: ParsedOnuInterfaceParts) {
  const lines = output.split('\n')
  const ponIndex = `${parts.pon}:${parts.onuId}`
  const ponIndexPattern = new RegExp(`^\\s*${escapeRegExp(ponIndex)}\\s+`, 'i')
  const onuInterfacePattern = new RegExp(`\\bgpon-onu_${escapeRegExp(parts.pon)}:${escapeRegExp(parts.onuId)}\\b`, 'i')
  const shortOnuIdPattern = new RegExp(`^\\s*${escapeRegExp(parts.onuId)}\\s+`, 'i')

  // Cari baris tabel status dulu. Hindari command echo seperti:
  // OLT-BALEN#show pon power attenuation gpon-onu_1/2/3:2
  const statusRow = lines.find((line) => {
    const trimmed = line.trim()
    if (!trimmed) return false
    if (/^OLT-.+#show\s+/i.test(trimmed) || /^show\s+/i.test(trimmed)) return false
    if (!/(working|offline|off-line|ready|online|los|dying|disable|disabled)/i.test(trimmed)) return false
    return ponIndexPattern.test(line) || shortOnuIdPattern.test(line)
  })

  if (statusRow) return statusRow

  // Fallback untuk output detail-info yang memuat nama interface.
  return lines.find((line) => {
    const trimmed = line.trim()
    if (!trimmed) return false
    if (/^OLT-.+#show\s+/i.test(trimmed) || /^show\s+/i.test(trimmed)) return false
    return onuInterfacePattern.test(line)
  }) || null
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function sanitizeOltOutput(output: string) {
  return output
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\r/g, '')
    .trim()
}
