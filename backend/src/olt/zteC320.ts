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

// OID MIB-II
const OID_SYS_DESCR = '1.3.6.1.2.1.1.1.0'
const OID_SYS_NAME = '1.3.6.1.2.1.1.5.0'

// OID ZTE C320 GPON ONU Status
const OID_ZTE_ONU_STATUS_PREFIX = '1.3.6.1.4.1.3902.1012.3.28.2.1.4'
// OID ZTE C320 GPON ONU RX Optical Power
const OID_ZTE_ONU_RX_POWER_PREFIX = '1.3.6.1.4.1.3902.1012.3.50.12.1.1.10'

export function getOltConfigFromEnv(): OltConnectionConfig {
  const host = process.env.OLT_HOST || '136.2.2.200'
  const community = process.env.OLT_COMMUNITY || process.env.OLT_PASSWORD || 'balen'

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
  const match = clean.match(/^(\d+)\/(\d+)\/(\d+)[:.](\d+)$/)

  if (!match) return null

  return {
    rack: Number(match[1]),
    shelf: Number(match[1]),
    slot: Number(match[2]),
    port: Number(match[3]),
    onuId: Number(match[4]),
  }
}

/**
 * Menghasilkan seluruh kandidat ifIndex GPON ZTE C320 untuk Port 1 - 16
 * Mengakomodasi variasi offset internal board GTGH/GTGO
 */
function calculateZteIfIndexCandidates(shelf: number, slot: number, port: number): number[] {
  const candidates: number[] = []

  if (slot === 2) {
    if (port <= 8) {
      candidates.push(268500992 + (port * 256))
    } else {
      candidates.push(268566528 + ((port - 8) * 256))
      candidates.push(268566784 + ((port - 9) * 256))
      candidates.push(268500992 + (port * 256))
    }
  }

  if (slot === 3) {
    if (port <= 8) {
      candidates.push(268566528 + (port * 256))
    } else {
      candidates.push(268632064 + ((port - 8) * 256))
    }
  }

  // Fallback standar ZTE bit-shifting
  const bitShiftIndex = (1 << 28) + (shelf << 24) + (slot << 19) + (port << 8)
  candidates.push(bitShiftIndex)
  candidates.push(268435456 + (slot * 4096) + (port * 256))

  return Array.from(new Set(candidates))
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

  // Jika nilai raw dalam format signed 16-bit
  if (rawVal > 30000 && rawVal <= 65536) {
    return Number(((rawVal - 65536) * 0.002 - 30).toFixed(2))
  }

  // Standar skala ZTE C320: (raw * 0.002) - 30 dBm
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
      rawStatusText: 'Format interface tidak valid (Gunakan format 1/2/13:52 atau gpon-onu_1/2/13:52)',
    }
  }

  const config = configParam || getOltConfigFromEnv()
  const candidateIndexes = calculateZteIfIndexCandidates(parsed.shelf, parsed.slot, parsed.port)

  const oidsToQuery: string[] = []
  for (const idx of candidateIndexes) {
    oidsToQuery.push(`${OID_ZTE_ONU_STATUS_PREFIX}.${idx}.${parsed.onuId}`)
    oidsToQuery.push(`${OID_ZTE_ONU_RX_POWER_PREFIX}.${idx}.${parsed.onuId}.1`)
    oidsToQuery.push(`${OID_ZTE_ONU_RX_POWER_PREFIX}.${idx}.${parsed.onuId}`)
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
      let matchedIndex = candidateIndexes[0]

      for (const idx of candidateIndexes) {
        const statusOid = `${OID_ZTE_ONU_STATUS_PREFIX}.${idx}.${parsed.onuId}`
        const rxOid1 = `${OID_ZTE_ONU_RX_POWER_PREFIX}.${idx}.${parsed.onuId}.1`
        const rxOid2 = `${OID_ZTE_ONU_RX_POWER_PREFIX}.${idx}.${parsed.onuId}`

        const statusVb = varbinds.find((vb) => vb.oid === statusOid && !snmp.isVarbindError(vb))
        const rxVb = varbinds.find(
          (vb) => (vb.oid === rxOid1 || vb.oid === rxOid2) && !snmp.isVarbindError(vb),
        )

        if (statusVb) {
          const val = Number(statusVb.value)
          if (val > 0) {
            statusCode = val
            matchedIndex = idx
            if (val === 3 || val === 5) onuStatus = 'ONLINE'
            else if (val === 6 || val === 2) onuStatus = 'LOS'
            else if (val === 4 || val === 1) onuStatus = 'OFFLINE'
          }
        }

        if (rxVb && rawRxValue === null) {
          const val = Number(rxVb.value)
          if (!Number.isNaN(val) && val !== 0 && val !== 65535 && val !== 2147483647) {
            rawRxValue = val
          }
        }
      }

      const rxPower = rawRxValue !== null ? convertZteRxPower(rawRxValue) : null

      resolve({
        onuInterface,
        onuStatus,
        onuRxPower: rxPower,
        rawStatusText:
          statusCode !== -1
            ? `Status OLT: ${onuStatus} (Code: ${statusCode})`
            : 'ONU Tidak Ditemukan di OLT',
        rawOutput: `Index: ${matchedIndex}.${parsed.onuId} -> Status: ${statusCode}, RawRx: ${rawRxValue}`,
      })
    })
  })
}