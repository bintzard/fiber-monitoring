import crypto from 'crypto'
import type { Server } from 'socket.io'
import { prisma } from '../prisma'
import { checkZteC320Onu, getOltConfigFromEnv, type OltConnectionConfig } from '../olt/zteC320'
import type {
  Prisma,
  Cable,
  CableStatus,
  MonitoringLogEventType,
  NetworkDevice,
  Node,
  NodeStatus,
} from '../generated/prisma/client'

const OLT_DEFAULT_INTERVAL_MS = 120000
const OLT_DEFAULT_DELAY_MS = 1500

let isRunning = false
let intervalHandle: NodeJS.Timeout | null = null

export function startOltMonitor(io: Server) {
  if (process.env.OLT_ENABLE_MONITOR !== 'true') {
    console.log('OLT monitor disabled. Set OLT_ENABLE_MONITOR=true to enable.')
    return
  }

  if (intervalHandle) {
    return
  }

  const intervalMs = Number(process.env.OLT_INTERVAL_MS || OLT_DEFAULT_INTERVAL_MS)
  const finalIntervalMs = Number.isFinite(intervalMs) && intervalMs >= 30000
    ? intervalMs
    : OLT_DEFAULT_INTERVAL_MS

  console.log(`OLT monitor started. Interval: ${finalIntervalMs}ms`)

  runOltCheck(io)

  intervalHandle = setInterval(() => {
    runOltCheck(io)
  }, finalIntervalMs)
}

function getRxWarningLimit() {
  const value = Number(process.env.OLT_RX_WARNING_DBM || -27)
  return Number.isFinite(value) ? value : -27
}

function getBatchDelayMs() {
  const value = Number(process.env.OLT_SCAN_BATCH_DELAY_MS || OLT_DEFAULT_DELAY_MS)
  return Number.isFinite(value) && value >= 300 ? value : OLT_DEFAULT_DELAY_MS
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function decryptSecret(value: string | null) {
  if (!value) return ''

  // Fallback untuk data lama/manual yang masih plain text.
  if (!value.startsWith('aes256gcm$')) {
    return value
  }

  try {
    const [, ivRaw, authTagRaw, encryptedRaw] = value.split('$')

    if (!ivRaw || !authTagRaw || !encryptedRaw) {
      return ''
    }

    const jwtSecret = process.env.JWT_SECRET || 'dev-secret-change-this-before-production'
    const key = crypto.createHash('sha256').update(jwtSecret).digest()

    const iv = Buffer.from(ivRaw, 'base64url')
    const authTag = Buffer.from(authTagRaw, 'base64url')
    const encrypted = Buffer.from(encryptedRaw, 'base64url')

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(authTag)

    return Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]).toString('utf8')
  } catch (error) {
    console.error('[OLT] Gagal decrypt password perangkat:', error)
    return ''
  }
}

function getDevicePassword(device: NetworkDevice) {
  return decryptSecret(device.passwordEncrypted)
}

function validateOltDevice(device: NetworkDevice) {
  return (
    device.type === 'OLT' &&
    device.isActive &&
    Boolean(device.host) &&
    Boolean(device.port) &&
    Boolean(device.username) &&
    Boolean(getDevicePassword(device))
  )
}

function buildOltConfigFromDevice(device: NetworkDevice): OltConnectionConfig {
  return {
    host: device.host,
    port: device.port,
    username: device.username || '',
    password: getDevicePassword(device),
    readyTimeoutMs: Number(process.env.OLT_READY_TIMEOUT_MS || 15000),
    commandTimeoutMs: Number(process.env.OLT_COMMAND_TIMEOUT_MS || 35000),
  }
}

async function updateOltDeviceConnected(device: NetworkDevice | null | undefined) {
  if (!device) return

  await prisma.networkDevice.update({
    where: {
      id: device.id,
    },
    data: {
      connectionStatus: 'CONNECTED',
      lastConnectedAt: new Date(),
      lastConnectionMessage: `Terhubung ke ${device.host}:${device.port}`,
    },
  })
}

async function updateOltDeviceError(device: NetworkDevice | null | undefined, error: unknown) {
  if (!device) return

  await prisma.networkDevice.update({
    where: {
      id: device.id,
    },
    data: {
      connectionStatus: 'ERROR',
      lastConnectionMessage:
        error instanceof Error ? error.message : 'Gagal konek ke OLT',
    },
  })
}

function getFallbackOltConfig() {
  try {
    return getOltConfigFromEnv()
  } catch {
    return null
  }
}

async function runOltCheck(io: Server) {
  if (isRunning) {
    console.log('[OLT] Skip check: previous OLT check is still running.')
    return
  }

  isRunning = true

  try {
    const monitoredNodes = await prisma.node.findMany({
      where: {
        type: 'CLIENT',
        monitoringEnabled: true,
        monitoringMethod: 'OLT',
        onuInterface: {
          not: null,
        },
      },
      orderBy: {
        id: 'asc',
      },
    })

    if (monitoredNodes.length === 0) {
      return
    }

    const oltDevices = await prisma.networkDevice.findMany({
      where: {
        type: 'OLT',
        isActive: true,
      },
      orderBy: {
        name: 'asc',
      },
    })

    const validOltDevices = oltDevices.filter(validateOltDevice)
    const deviceMap = new Map(validOltDevices.map((device) => [device.id, device]))
    const fallbackConfig = getFallbackOltConfig()

    console.log(
      `[OLT] Checking ${monitoredNodes.length} ONU client(s). Device OLT aktif: ${validOltDevices.length}.`,
    )

    const delayMs = getBatchDelayMs()

    for (const node of monitoredNodes) {
      if (!node.onuInterface) continue

      const selectedDevice = node.oltDeviceId
        ? deviceMap.get(node.oltDeviceId)
        : null

      const config = selectedDevice
        ? buildOltConfigFromDevice(selectedDevice)
        : fallbackConfig

      if (!config) {
        console.warn(
          `[OLT] Skip ${node.name}: belum ada OLT Device aktif dan konfigurasi .env tidak tersedia.`,
        )
        continue
      }

      try {
        await checkOneOltNode(io, node, config, selectedDevice)
      } catch (error) {
        await updateOltDeviceError(selectedDevice, error)
        console.error(`[OLT] Gagal cek ${node.name} (${node.onuInterface}):`, error)
      }

      if (delayMs > 0) {
        await sleep(delayMs)
      }
    }
  } catch (error) {
    console.error('OLT MONITOR ERROR:', error)
  } finally {
    isRunning = false
  }
}

async function checkOneOltNode(
  io: Server,
  node: Node,
  config: OltConnectionConfig,
  oltDevice?: NetworkDevice | null,
) {
  if (!node.onuInterface) return

  const result = await checkZteC320Onu(node.onuInterface, config)
  await updateOltDeviceConnected(oltDevice)
  const nextStatus = mapOnuStatusToNodeStatus(result.onuStatus, result.onuRxPower)
  const now = new Date()

  const shouldUpdate =
    node.status !== nextStatus ||
    node.rxPower !== result.onuRxPower ||
    node.onuStatus !== result.onuStatus ||
    node.onuRxPower !== result.onuRxPower ||
    node.onuInterface !== result.onuInterface

  if (!shouldUpdate) {
    const checkedNode = await prisma.node.update({
      where: {
        id: node.id,
      },
      data: {
        lastCheckedAt: now,
        onuLastCheckedAt: now,
        lastSeenAt: nextStatus === 'ONLINE' || nextStatus === 'WARNING' ? now : node.lastSeenAt,
        offlineSince:
          nextStatus === 'OFFLINE'
            ? node.offlineSince || now
            : null,
      },
    })

    io.emit('node-status-updated', checkedNode)
    return
  }

  const updatedNode = await prisma.node.update({
    where: {
      id: node.id,
    },
    data: {
      status: nextStatus,
      monitoringMethod: 'OLT',
      monitoringEnabled: true,
      onuInterface: result.onuInterface,
      onuStatus: result.onuStatus,
      onuRxPower: result.onuRxPower,
      onuLastCheckedAt: now,
      rxPower: result.onuRxPower,
      lastCheckedAt: now,
      lastSeenAt: nextStatus === 'ONLINE' || nextStatus === 'WARNING' ? now : node.lastSeenAt,
      offlineSince:
        nextStatus === 'OFFLINE'
          ? node.offlineSince || now
          : null,
    },
  })

  if (node.status !== updatedNode.status) {
    await createMonitoringLog(io, {
      nodeId: updatedNode.id,
      eventType: getMonitoringLogEventType(updatedNode.status),
      oldStatus: node.status,
      newStatus: updatedNode.status,
      title: getMonitoringLogTitle(updatedNode.status),
      message: getMonitoringLogMessage(updatedNode, result.onuRxPower),
      metadata: {
        source: 'OLT_ZTE_C320_AUTO_MONITOR',
        onuInterface: result.onuInterface,
        onuStatus: result.onuStatus,
        onuRxPower: result.onuRxPower,
        rawStatusText: result.rawStatusText,
      },
    })
  }

  const affectedCables = await updateCableStatusByNode(node.id, updatedNode.status)
  const recalculatedTopology = await recalculateOdpStatusByClient(node.id)

  io.emit('node-status-updated', updatedNode)

  affectedCables.forEach((cable) => {
    io.emit('cable-status-updated', cable)
  })

  recalculatedTopology.updatedNodes.forEach((updatedTopologyNode) => {
    io.emit('node-status-updated', updatedTopologyNode)
  })

  recalculatedTopology.updatedCables.forEach((updatedCable) => {
    io.emit('cable-status-updated', updatedCable)
  })

  console.log(
    `[OLT] ${updatedNode.name} (${result.onuInterface}) => ${updatedNode.status} / ${result.onuStatus} / RX ${result.onuRxPower ?? '-'} dBm`,
  )
}

function mapOnuStatusToNodeStatus(
  onuStatus: string | null | undefined,
  onuRxPower: number | null,
): NodeStatus {
  if (onuStatus === 'ONLINE') {
    const rxWarningLimit = getRxWarningLimit()
    return onuRxPower !== null && onuRxPower <= rxWarningLimit ? 'WARNING' : 'ONLINE'
  }

  if (onuStatus === 'OFFLINE' || onuStatus === 'LOS' || onuStatus === 'DYING_GASP') {
    return 'OFFLINE'
  }

  return 'UNKNOWN'
}

function getMonitoringLogEventType(status: NodeStatus): MonitoringLogEventType {
  if (status === 'ONLINE') return 'NODE_ONLINE'
  if (status === 'OFFLINE') return 'NODE_OFFLINE'
  if (status === 'WARNING') return 'NODE_WARNING'
  return 'NODE_UNKNOWN'
}

function getMonitoringLogTitle(status: NodeStatus) {
  if (status === 'ONLINE') return 'ONU ONLINE kembali'
  if (status === 'OFFLINE') return 'ONU OFFLINE / LOS'
  if (status === 'WARNING') return 'ONU WARNING'
  return 'Status ONU tidak diketahui'
}

function getMonitoringLogMessage(node: Node, onuRxPower: number | null) {
  if (node.status === 'ONLINE') {
    return `${node.name} online dari monitoring OLT.`
  }

  if (node.status === 'OFFLINE') {
    return `${node.name} offline/LOS dari monitoring OLT.`
  }

  if (node.status === 'WARNING') {
    return `${node.name} warning dari monitoring OLT. RX ${onuRxPower ?? '-'} dBm.`
  }

  return `${node.name} status OLT tidak diketahui.`
}

type MonitoringLogPayload = {
  nodeId: string
  eventType: MonitoringLogEventType
  oldStatus: NodeStatus | null
  newStatus: NodeStatus
  title: string
  message: string
  metadata?: Record<string, unknown>
}

async function createMonitoringLog(io: Server, payload: MonitoringLogPayload) {
  try {
    const log = await prisma.monitoringLog.create({
      data: {
        nodeId: payload.nodeId,
        eventType: payload.eventType,
        oldStatus: payload.oldStatus,
        newStatus: payload.newStatus,
        title: payload.title,
        message: payload.message,
        metadata: payload.metadata ? (payload.metadata as Prisma.InputJsonValue) : undefined,
      },
      include: {
        node: {
          select: {
            id: true,
            name: true,
            type: true,
            status: true,
            ipAddress: true,
          },
        },
      },
    })

    io.emit('monitoring-log-created', log)
  } catch (error) {
    console.error('Gagal membuat MonitoringLog OLT:', error)
  }
}

async function updateCableStatusByNode(
  nodeId: string,
  status: NodeStatus,
): Promise<Cable[]> {
  const affectedCables: Cable[] = []

  const relatedCable = await prisma.cable.findFirst({
    where: {
      toNodeId: nodeId,
    },
  })

  if (relatedCable) {
    const updatedRelatedCable = await prisma.cable.update({
      where: {
        id: relatedCable.id,
      },
      data: {
        status: status === 'OFFLINE' ? 'BROKEN' : 'NORMAL',
      },
    })

    affectedCables.push(updatedRelatedCable)
  }

  return affectedCables
}

async function recalculateOdpStatusByClient(clientId: string): Promise<{
  updatedNodes: Node[]
  updatedCables: Cable[]
}> {
  const client = await prisma.node.findUnique({
    where: {
      id: clientId,
    },
  })

  if (!client || client.type !== 'CLIENT' || !client.parentId) {
    return {
      updatedNodes: [],
      updatedCables: [],
    }
  }

  const odp = await prisma.node.findUnique({
    where: {
      id: client.parentId,
    },
  })

  if (!odp || odp.type !== 'ODP') {
    return {
      updatedNodes: [],
      updatedCables: [],
    }
  }

  const clients = await prisma.node.findMany({
    where: {
      type: 'CLIENT',
      parentId: odp.id,
    },
  })

  const offlineClients = clients.filter((item) => item.status === 'OFFLINE')

  let odpStatus: NodeStatus = 'ONLINE'
  let cableToOdpStatus: CableStatus = 'NORMAL'

  if (clients.length <= 1) {
    odpStatus = 'ONLINE'
    cableToOdpStatus = 'NORMAL'
  } else if (offlineClients.length === 0) {
    odpStatus = 'ONLINE'
    cableToOdpStatus = 'NORMAL'
  } else if (offlineClients.length < clients.length) {
    odpStatus = 'WARNING'
    cableToOdpStatus = 'NORMAL'
  } else {
    odpStatus = 'OFFLINE'
    cableToOdpStatus = 'AFFECTED'
  }

  const updatedNodes: Node[] = []
  const updatedCables: Cable[] = []

  const updatedOdp = await prisma.node.update({
    where: {
      id: odp.id,
    },
    data: {
      status: odpStatus,
    },
  })

  updatedNodes.push(updatedOdp)

  const cableToOdp = await prisma.cable.findFirst({
    where: {
      toNodeId: odp.id,
    },
  })

  if (cableToOdp) {
    const updatedCableToOdp = await prisma.cable.update({
      where: {
        id: cableToOdp.id,
      },
      data: {
        status: cableToOdpStatus,
      },
    })

    updatedCables.push(updatedCableToOdp)
  }

  return {
    updatedNodes,
    updatedCables,
  }
}
