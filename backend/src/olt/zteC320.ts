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

// OID Base ZTE C320 / C300 GPON
// Status Registrasi: 1: logging, 2: los, 3: syncMib, 4: offline, 5: working/online
const OID_ZTE_ONU_STATUS_PREFIX = '1.3.6.1.4.1.3902.1012.3.28.2.1.4'
// Redaman RX Optical Power ONU
const OID_ZTE_ONU_RX_POWER_PREFIX = '1.3.6.1.4.1.3902.1012.3.50.12.1.1.10'

export function getOltConfigFromEnv(): OltConnectionConfig {
  const host = process.env.OLT_HOST
  if (!host) {
    throw new Error('OLT_HOST tidak diset di .env')
  }

  const community = process.env.OLT_COMMUNITY || process.env.OLT_PASSWORD
  if (!community) {
    throw new Error('OLT_COMMUNITY / OLT_PASSWORD wajib diset di .env (tidak menggunakan public)')
  }

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

/**
 * Konversi format string gpon-onu_1/X/Y:Z ke index angka SNMP ZTE
 */
export function parseZteOnuIndex(onuInterface: string): { rack: number; shelf: number; slot: number; port: number; onuId: number } | null {
  const clean = onuInterface.replace(/^(gpon[-_]onu[-_:]?)/i, '')
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

/**
 * Menghitung OID Index ZTE C320/C300 untuk GPON ONU
 * Formula standar ZTE: 268500992 + (shelf * 65536) + (slot * 2048) + (port * 256)
 */
function calculateZteIfIndex(shelf: number, slot: number, port: number): number {
  return 268500992 + (slot * 256) + port
}

/**
 * Konversi raw integer optical power ZTE ke dBm
 */
function convertZteRxPower(rawVal: number): number | null {
  if (rawVal === 0 || rawVal === 65535 || rawVal === 2147483647 || rawVal === -1) {
    return null
  }
  // Formula optical power ZTE: (val * 0.002) - 30 dBm atau jika nilai bertipe signed 16-bit
  if (rawVal > 30000) {
    return Number(((rawVal - 65536) * 0.002 - 30).toFixed(2))
  }
  const calculated = (rawVal * 0.002) - 30
  return Number(calculated.toFixed(2))
}

/**
 * Test koneksi dasar ke OLT via SNMP (sysName & sysDescr)
 */
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
        reject(new Error(`SNMP Timeout: Tidak ada respon dari OLT ${config.host}:${config.port}`))
      }
    }, (config.timeoutMs || 4000) + 500)

    session.get([OID_SYS_DESCR, OID_SYS_NAME], (err: any, varbinds: any[]) => {
      if (isResolved) return
      isResolved = true
      clearTimeout(timer)

      if (err) {
        try { session.close() } catch {}
        reject(new Error(`Gagal query SNMP OLT: ${err.message || err}`))
        return
      }

      let sysDescr = '-'
      let sysName = '-'

      for (const vb of varbinds) {
        if (snmp.isVarbindError(vb)) continue
        if (vb.oid === OID_SYS_DESCR) sysDescr = vb.value?.toString() || '-'
        if (vb.oid === OID_SYS_NAME) sysName = vb.value?.toString() || '-'
      }

      try { session.close() } catch {}

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

/**
 * Cek status dan RX dBm satu ONU via SNMP Direct OID (Direct get, bukan subtree walk)
 */
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
      rawStatusText: 'Format interface tidak valid (Gunakan format 1/x/y:z atau gpon-onu_1/x/y:z)',
    }
  }

  const config = configParam || getOltConfigFromEnv()
  const ifIndex = calculateZteIfIndex(parsed.shelf, parsed.slot, parsed.port)
  
  // Full specific OID untuk ONU tersebut
  const targetStatusOid = `${OID_ZTE_ONU_STATUS_PREFIX}.${ifIndex}.${parsed.onuId}`
  const targetRxPowerOid = `${OID_ZTE_ONU_RX_POWER_PREFIX}.${ifIndex}.${parsed.onuId}.1`

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
          rawStatusText: 'SNMP Request Timeout',
        })
      }
    }, (config.timeoutMs || 4000) + 500)

    session.get([targetStatusOid, targetRxPowerOid], (err: any, varbinds: any[]) => {
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

        if (vb.oid.startsWith(OID_ZTE_ONU_STATUS_PREFIX)) {
          statusCode = Number(vb.value)
          if (statusCode === 5) onuStatus = 'ONLINE'
          else if (statusCode === 4) onuStatus = 'OFFLINE'
          else if (statusCode === 2) onuStatus = 'LOS'
          else if (statusCode === 1) onuStatus = 'OFFLINE' // Logging/Deregistered
        }

        if (vb.oid.startsWith(OID_ZTE_ONU_RX_POWER_PREFIX)) {
          rawRxValue = Number(vb.value)
        }
      }

      const rxPower = (onuStatus === 'ONLINE' && rawRxValue !== null) ? convertZteRxPower(rawRxValue) : null

      resolve({
        onuInterface,
        onuStatus,
        onuRxPower: rxPower,
        rawStatusText: statusCode !== -1 ? `SNMP Status Code: ${statusCode} (${onuStatus})` : 'ONU Not Found / No Response',
        rawOutput: `RawStatusCode: ${statusCode}, RawRx: ${rawRxValue}`,
      })
    })
  })
}