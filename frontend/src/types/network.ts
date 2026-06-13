export type NodeType = 'OLT' | 'POLE' | 'ODP' | 'CLIENT' | 'ROUTER'

export type NodeStatus = 'ONLINE' | 'OFFLINE' | 'WARNING' | 'UNKNOWN'

export type MonitoringMethod = 'MANUAL' | 'PING' | 'PPPOE' | 'OLT' | 'SNMP'

export type CableType = 'BACKBONE' | 'DISTRIBUTION' | 'DROP_WIRE'

export type CableStatus = 'NORMAL' | 'AFFECTED' | 'BROKEN' | 'UNKNOWN'

export interface NetworkNode {
  id: string
  name: string
  type: NodeType
  ipAddress: string | null
  latitude: number
  longitude: number
  status: NodeStatus
  rxPower: number | null
  parentId: string | null

  pppoeUsername: string | null
  monitoringEnabled: boolean
  monitoringMethod: MonitoringMethod
  lastCheckedAt: string | null
  lastSeenAt: string | null
  offlineSince: string | null
  latencyMs: number | null

  createdAt?: string
  updatedAt?: string
}

export interface Cable {
  id: string
  name: string
  type: CableType
  fromNodeId: string
  toNodeId: string
  status: CableStatus
  coordinates: [number, number][]
  createdAt?: string
  updatedAt?: string
}
