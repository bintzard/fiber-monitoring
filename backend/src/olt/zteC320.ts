import * as snmp from 'net-snmp'

export interface OltConnectionConfig {
  host: string
  port: number
  community: string
  timeoutMs?: number
}

export interface OnuCheckResult {
  onuInterface: string
  onuStatus: 'ONLINE' | 'OFFLINE' | 'LOS' | 'UNKNOWN'
  onuRxPower: number | null
  rawStatusText?: string
  rawOutput?: string
}

// OID Standar MIB-II
const OID_SYS_DESCR = '1.3.6.1.2.1.1.1.0'
const OID_SYS_NAME = '1.3.6.1.2.1.1.5.0'

// OID ZTE C320 GPON Status & RX Power
const OID_STATUS_V1 = '1.3.6.1.4.1.3902.1012.3.28.2.1.4'
const OID_RX_POWER_V1 = '1.3.6.1.4.1.3902.1012.3.50.12.1.1.10'
const OID_STATUS_V2 = '1.3.6.1.4.1.3902.1082.500.1.2.1.1'

export function getOltConfigFromEnv(): OltConnectionConfig {
  const host = process.env.OLT_HOST || '127.0.0.1'
  const community = process.env.OLT_COMMUNITY || process.env.OLT_PASSWORD || 'public'

  return {
    host,
    port: Number(process.env.OLT_PORT || 161),
    community,
    timeoutMs: Number(process.env.OLT_TIMEOUT_MS || 4000),
  }
}

function createSession(config: OltConnectionConfig): any {
  if (!config.community) {
    throw new Error('SNMP Community wajib diisi')
  }

  return snmp.createSession(config.host, config.community, {
    port: config.port || 161,
    retries: 1,
    timeout: config.timeoutMs || 4000,
    version: snmp.Version2c,
  })
}

export function parseZteOnuIndex(onuInterface: string): {
  rack: number
  shelf: number
  slot: number
  port: number
  onuId: number
} | null {
  const clean = onuInterface.replace(/^(gpon[-_]onu[-_:]?)/i, '').trim()
  const match = clean.match(/^(\d+)\/(\d+)\/(\d+):(\d+)$/)

  if (!match) return null

  return {
    rack: Number(match[1]),
    shelf: Number(match[1]),
    slot: Number(match[2]),
    port: Number(match[3]),
    onuId: Number(match[4]),
  }
}

// Menghasilkan daftar kemungkinan ifIndex untuk ZTE C320
function getPossibleIfIndexes(shelf: number, slot: number, port: number): number[] {
  return [
    268500992 + (slot * 256) + port,                 // Standar ZTE C320 Slot Base 256
    268435456 + (shelf * 65536) + (slot * 256) + port, // Formula Bit Shift
    (1 << 28) + (slot << 8) + port,                   // Firmware V2.x
    268435456 + (slot * 256) + port,
  ]
}

function convertZteRxPower(rawVal: number): number | null {
  if (
    rawVal === 0 ||
    rawVal === 65535 ||
    rawVal === 2147483647 ||
    rawVal === -1 ||
    rawVal === 2147483648
  ) {
    return null
  }

  if (rawVal > 30000 && rawVal <= 65536) {
    return Number(((rawVal - 65536) * 0.002 - 30).toFixed(2))
  }

  const calculated = rawVal * 0.002 - 30
  if (calculated < -45 || calculated > 10) {
    const altCalculated = rawVal * 0.01
    if (altCalculated >= -45 && altCalculated <= 10) {
      return Number(altCalculated.toFixed(2))
    }
  }

  return Number(calculated.toFixed(2))
}

export async function testOltConnection(configParam?: OltConnectionConfig): Promise<{
  success: boolean
  message: string
  host: string
  sysName: string
  output: string
}> {
  const config = configParam || getOltConfigFromEnv()

  return new Promise((resolve, reject) => {
    let session: any
    try {
      session = createSession(config)
    } catch (err: any) {
      return reject(err)
    }

    let isResolved = false
    const timer = setTimeout(() => {
      if (!isResolved) {
        isResolved = true
        try { session.close() } catch {}
        reject(new Error(`SNMP Timeout ke OLT ${config.host}:${config.port}`))
      }
    }, (config.timeoutMs || 4000) + 500)

    session.get([OID_SYS_DESCR, OID_SYS_NAME], (err: any, varbinds: any[]) => {
      if (isResolved) return
      isResolved = true
      clearTimeout(timer)
      try { session.close() } catch {}

      if (err) {
        return reject(new Error(`Gagal query SNMP OLT: ${err.message || err}`))
      }

      let sysDescr = '-'
      let sysName = '-'

      for (const vb of varbinds) {
        if (snmp.isVarbindError(vb)) continue
        if (vb.oid === OID_SYS_DESCR) sysDescr = vb.value?.toString() || '-'
        if (vb.oid === OID_SYS_NAME) sysName = vb.value?.toString() || '-'
      }

      resolve({
        success: true,
        message: `Koneksi SNMP Berhasil (${sysName})`,
        host: config.host,
        sysName,
        output: `${sysName} | ${sysDescr}`,
      })
    })
  })
}

export async function checkZteC320Onu(
  onuInterface: string,
  configParam?: OltConnectionConfig,
): Promise<OnuCheckResult> {
  const parsed = parseZteOnuIndex(onuInterface)
  if (!parsed) {
    return {
      onuInterface,
      onuStatus: 'UNKNOWN',
      onuRxPower: null,
      rawStatusText: 'Format interface tidak valid (Gunakan format gpon-onu_1/2/3:11)',
    }
  }

  const config = configParam || getOltConfigFromEnv()
  const possibleIndexes = getPossibleIfIndexes(parsed.shelf, parsed.slot, parsed.port)

  // Buat kumpulan OID untuk semua kemungkinan index
  const oidsToQuery: string[] = []
  for (const idx of possibleIndexes) {
    oidsToQuery.push(`${OID_STATUS_V1}.${idx}.${parsed.onuId}`)
    oidsToQuery.push(`${OID_RX_POWER_V1}.${idx}.${parsed.onuId}.1`)
    oidsToQuery.push(`${OID_RX_POWER_V1}.${idx}.${parsed.onuId}`)
    oidsToQuery.push(`${OID_STATUS_V2}.${idx}.${parsed.onuId}`)
  }

  return new Promise((resolve) => {
    let session: any
    try {
      session = createSession(config)
    } catch (err: any) {
      return resolve({
        onuInterface,
        onuStatus: 'UNKNOWN',
        onuRxPower: null,
        rawStatusText: `Session Error: ${err.message || err}`,
      })
    }

    let isResolved = false
    const timeout = setTimeout(() => {
      if (!isResolved) {
        isResolved = true
        try { session.close() } catch {}
        resolve({
          onuInterface,
          onuStatus: 'UNKNOWN',
          onuRxPower: null,
          rawStatusText: `Timeout SNMP ke OLT ${config.host}`,
        })
      }
    }, (config.timeoutMs || 4000) + 500)

    session.get(oidsToQuery, (err: any, varbinds: any[]) => {
      if (isResolved) return
      isResolved = true
      clearTimeout(timeout)
      try { session.close() } catch {}

      if (err) {
        return resolve({
          onuInterface,
          onuStatus: 'UNKNOWN',
          onuRxPower: null,
          rawStatusText: `SNMP Error: ${err.message || err}`,
        })
      }

      let onuStatus: OnuCheckResult['onuStatus'] = 'UNKNOWN'
      let statusCode = -1
      let rawRxValue: number | null = null

      for (const vb of varbinds) {
        if (snmp.isVarbindError(vb)) continue

        if (vb.oid.includes(OID_STATUS_V1) || vb.oid.includes(OID_STATUS_V2)) {
          const val = Number(vb.value)
          if (!Number.isNaN(val) && val > 0) {
            statusCode = val
            if (statusCode === 5 || statusCode === 3) onuStatus = 'ONLINE'
            else if (statusCode === 4) onuStatus = 'OFFLINE'
            else if (statusCode === 2) onuStatus = 'LOS'
            else if (statusCode === 1) onuStatus = 'OFFLINE'
          }
        }

        if (vb.oid.includes(OID_RX_POWER_V1) && rawRxValue === null) {
          const val = Number(vb.value)
          if (!Number.isNaN(val) && val !== 0 && val !== 65535) {
            rawRxValue = val
          }
        }
      }

      const rxPower = onuStatus === 'ONLINE' && rawRxValue !== null ? convertZteRxPower(rawRxValue) : null

      resolve({
        onuInterface,
        onuStatus,
        onuRxPower: rxPower,
        rawStatusText: statusCode !== -1 ? `Status Code: ${statusCode} (${onuStatus})` : 'ONU Not Found / OID Tidak Cocok',
        rawOutput: `Status: ${statusCode}, RxRaw: ${rawRxValue}`,
      })
    })
  })
}