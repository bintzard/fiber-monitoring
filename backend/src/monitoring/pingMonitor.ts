import * as ping from 'ping'
import type { Server } from 'socket.io'
import { prisma } from '../prisma'
import type {
  Cable,
  CableStatus,
  MonitoringLogEventType,
  Node,
  NodeStatus,
} from '../generated/prisma/client'

const PING_INTERVAL_MS = 15000
const PING_TIMEOUT_SECONDS = 2

export function startPingMonitor(io: Server) {
  console.log('Ping monitor started...')

  runPingCheck(io)

  setInterval(() => {
    runPingCheck(io)
  }, PING_INTERVAL_MS)
}

async function runPingCheck(io: Server) {
  try {
    const monitoredNodes = await prisma.node.findMany({
      where: {
        monitoringEnabled: true,
        monitoringMethod: 'PING',
        ipAddress: {
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

    for (const node of monitoredNodes) {
      if (!node.ipAddress) continue

      const result = await ping.promise.probe(node.ipAddress, {
        timeout: PING_TIMEOUT_SECONDS,
      })

      const nextStatus: NodeStatus = result.alive ? 'ONLINE' : 'OFFLINE'

      const latencyMs =
        result.alive && result.time !== undefined && result.time !== null
          ? Number(result.time)
          : null

      const shouldUpdateStatus =
        node.status !== nextStatus || node.latencyMs !== latencyMs

      if (shouldUpdateStatus) {
        const updatedNode = await updateNodeStatusFromPing(
          node.id,
          nextStatus,
          latencyMs,
        )

        if (node.status !== updatedNode.status) {
          await createMonitoringLog(io, {
            nodeId: updatedNode.id,
            eventType: getMonitoringLogEventType(updatedNode.status),
            oldStatus: node.status,
            newStatus: updatedNode.status,
            title: getMonitoringLogTitle(updatedNode.status),
            message: `${updatedNode.name} berubah menjadi ${updatedNode.status} lewat monitoring PING.`,
          })
        }

        const affectedCables = await updateCableStatusByNode(
          node.id,
          nextStatus,
        )

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
          `[PING] ${node.name} (${node.ipAddress}) => ${nextStatus} ${
            latencyMs !== null ? `${latencyMs} ms` : ''
          }`,
        )
      } else {
        await updateLastCheckedAt(node.id, nextStatus)
      }
    }
  } catch (error) {
    console.error('PING MONITOR ERROR:', error)
  }
}

async function updateNodeStatusFromPing(
  nodeId: string,
  status: NodeStatus,
  latencyMs: number | null,
): Promise<Node> {
  const existingNode = await prisma.node.findUnique({
    where: {
      id: nodeId,
    },
  })

  if (!existingNode) {
    throw new Error('Node tidak ditemukan saat update ping status.')
  }

  const now = new Date()

  return prisma.node.update({
    where: {
      id: nodeId,
    },
    data: {
      status,
      latencyMs,
      lastCheckedAt: now,
      lastSeenAt: status === 'ONLINE' ? now : existingNode.lastSeenAt,
      offlineSince:
        status === 'OFFLINE' ? existingNode.offlineSince || now : null,
    },
  })
}

async function updateLastCheckedAt(
  nodeId: string,
  status: NodeStatus,
): Promise<void> {
  const existingNode = await prisma.node.findUnique({
    where: {
      id: nodeId,
    },
  })

  if (!existingNode) return

  const now = new Date()

  await prisma.node.update({
    where: {
      id: nodeId,
    },
    data: {
      lastCheckedAt: now,
      lastSeenAt: status === 'ONLINE' ? now : existingNode.lastSeenAt,
      offlineSince:
        status === 'OFFLINE' ? existingNode.offlineSince || now : null,
    },
  })
}


function getMonitoringLogEventType(status: NodeStatus): MonitoringLogEventType {
  if (status === 'ONLINE') return 'NODE_ONLINE'
  if (status === 'OFFLINE') return 'NODE_OFFLINE'
  if (status === 'WARNING') return 'NODE_WARNING'
  return 'NODE_UNKNOWN'
}

function getMonitoringLogTitle(status: NodeStatus) {
  if (status === 'ONLINE') return 'Client ONLINE kembali'
  if (status === 'OFFLINE') return 'Client OFFLINE'
  if (status === 'WARNING') return 'Client WARNING'
  return 'Status client berubah'
}

type MonitoringLogPayload = {
  nodeId: string
  eventType: MonitoringLogEventType
  oldStatus: NodeStatus | null
  newStatus: NodeStatus
  title: string
  message: string
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
    console.error('Gagal membuat MonitoringLog PING:', error)
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