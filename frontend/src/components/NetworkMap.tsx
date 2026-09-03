import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  MapContainer,
  Marker,
  Polyline,
  Popup,
  TileLayer,
  useMap,
  useMapEvents,
} from 'react-leaflet'
import L from 'leaflet'
import { io } from 'socket.io-client'
import type { Cable, NetworkNode } from '../types/network'
import type { AuthUser } from '../types/auth'
import { getAuthToken } from '../api/auth'
import AddNodeForm from './AddNodeForm'
import EditNodeForm from './EditNodeForm'
import AdminPanel from './AdminPanel'
import AddClientForm from './AddClientForm'
import EditClientForm from './EditClientForm'
import MarkerClusterGroup from './MarkerCluster'
import CableLayer from './CableLayer'

const API_BASE_URL =
  import.meta.env.VITE_API_URL ||
  (import.meta.env.DEV ? 'http://localhost:4000' : window.location.origin)
const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || API_BASE_URL

const socket = io(SOCKET_URL)

interface NetworkMapProps {
  currentUser: AuthUser
  onLogout: () => void
}

function getAuthorizedHeaders(includeJson = false) {
  const token = getAuthToken()

  return {
    ...(includeJson ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

interface SelectedCoordinate {
  latitude: number
  longitude: number
}

interface FaultAlert {
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  title: string
  message: string
  suspectedNodeId: string | null
  suspectedNodeName: string | null
  suspectedCableId: string | null
  suspectedCableName: string | null
  affectedClients: number
  totalClients: number
  offlineClientNames: string[]
}

interface OfflineNotification {
  id: string
  nodeName: string
  ipAddress: string | null
  status: string
  time: string
  message?: string
}

interface MonitoringLogRecord {
  id: string
  eventType: string
  oldStatus: string | null
  newStatus: string | null
  message: string
  createdAt: string
  metadata: unknown
  node: {
    id: string
    name: string
    type: string
    status: string
    ipAddress?: string | null
  } | null
}

interface NetworkDeviceRecord {
  id: string
  name: string
  type: 'MIKROTIK' | 'OLT'
  host: string
  port: number
  username: string
  hasPassword: boolean
  brand: string | null
  model: string | null
  notes: string | null
  isActive: boolean
  connectionStatus: 'UNKNOWN' | 'CONNECTED' | 'DISCONNECTED' | 'ERROR'
  lastConnectedAt: string | null
  lastConnectionMessage: string | null
  createdAt: string
  updatedAt: string
}

type SidebarPanel = 'search' | 'alert' | 'filter' | 'stats' | 'devices'
type PickingLocationSource = 'node' | 'client' | null
type CableTypeValue = 'BACKBONE' | 'DISTRIBUTION' | 'DROP_WIRE'
type CableStatusValue = 'NORMAL' | 'AFFECTED' | 'BROKEN' | 'UNKNOWN'
type CableRouteCoordinate = [number, number]

interface MapClickHandlerProps {
  isPickingLocation: boolean
  onPickLocation: (coordinate: SelectedCoordinate) => void
  isEditingCablePath?: boolean
  onAddCablePathPoint?: (coordinate: SelectedCoordinate) => void
}

interface MapFocusControllerProps {
  targetNode: NetworkNode | null
}

interface MapDefaultCenterControllerProps {
  defaultNode: NetworkNode | null
  targetNode: NetworkNode | null
  isPickingLocation: boolean
  isEditingCablePath: boolean
}

interface MapResizeControllerProps {
  trigger: boolean
}

function OfflineDurationDisplay({ offlineSince }: { offlineSince: string | null }) {
  const [duration, setDuration] = useState(() => formatOfflineDuration(offlineSince, Date.now()))

  useEffect(() => {
    if (!offlineSince) return
    const timer = window.setInterval(() => {
      setDuration(formatOfflineDuration(offlineSince, Date.now()))
    }, 1000)

    return () => window.clearInterval(timer)
  }, [offlineSince])

  return <b>{duration}</b>
}

function MapClickHandler({
  isPickingLocation,
  onPickLocation,
  isEditingCablePath = false,
  onAddCablePathPoint,
}: MapClickHandlerProps) {
  useMapEvents({
    click(event) {
      const coordinate = {
        latitude: Number(event.latlng.lat.toFixed(7)),
        longitude: Number(event.latlng.lng.toFixed(7)),
      }

      if (isEditingCablePath && onAddCablePathPoint) {
        onAddCablePathPoint(coordinate)
        return
      }

      if (!isPickingLocation) return

      onPickLocation(coordinate)
    },
  })

  return null
}

function MapFocusController({ targetNode }: MapFocusControllerProps) {
  const map = useMap()

  useEffect(() => {
    if (!targetNode) return

    map.flyTo([targetNode.latitude, targetNode.longitude], 20, {
      duration: 0.8,
    })
  }, [map, targetNode])

  return null
}

function MapDefaultCenterController({
  defaultNode,
  targetNode,
  isPickingLocation,
  isEditingCablePath,
}: MapDefaultCenterControllerProps) {
  const map = useMap()
  const hasCenteredRef = useRef(false)

  useEffect(() => {
    if (hasCenteredRef.current) return
    if (!defaultNode) return
    if (targetNode || isPickingLocation || isEditingCablePath) return

    hasCenteredRef.current = true
    map.setView([defaultNode.latitude, defaultNode.longitude], 18, {
      animate: false,
    })
  }, [map, defaultNode, targetNode, isPickingLocation, isEditingCablePath])

  return null
}

function MapResizeController({ trigger }: MapResizeControllerProps) {
  const map = useMap()

  useEffect(() => {
    const timer = window.setTimeout(() => {
      map.invalidateSize()
    }, 250)

    return () => {
      window.clearTimeout(timer)
    }
  }, [map, trigger])

  return null
}

function getMarkerColor(status: string) {
  if (status === 'ONLINE') return 'green'
  if (status === 'OFFLINE') return 'red'
  if (status === 'WARNING') return 'orange'
  return 'gray'
}

function createMarkerIcon(
  node: NetworkNode,
  isHighlighted = false,
  capacityInfo: OdpPortCapacityInfo | null = null,
) {
  const shouldUseCapacityColor =
    node.type === 'ODP' &&
    node.status !== 'OFFLINE' &&
    node.status !== 'WARNING' &&
    capacityInfo !== null

  const markerColor = shouldUseCapacityColor
    ? capacityInfo.markerColor
    : getMarkerColor(node.status)
  const color = isHighlighted ? '#0ea5e9' : markerColor
  const blinkClass = ''
  const highlightClass = isHighlighted ? 'highlight-marker' : ''
  const capacityClass = shouldUseCapacityColor
    ? `odp-capacity-marker odp-capacity-${capacityInfo.state}`
    : ''
  const capacityLabel =
    shouldUseCapacityColor && capacityInfo.shortLabel
      ? `<span class="odp-marker-caption odp-marker-caption-${capacityInfo.state}">${capacityInfo.shortLabel}</span>`
      : ''

  return L.divIcon({
    className: '',
    html: `
      <div class="marker-wrapper">
        <div class="marker-dot ${blinkClass} ${highlightClass} ${capacityClass}" style="
          background:${color};
          width:18px;
          height:18px;
          border-radius:50%;
          border:3px solid white;
          box-shadow:0 0 8px rgba(0,0,0,0.45);
        "></div>
        ${capacityLabel}
      </div>
    `,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  })
}

function createSelectedLocationIcon() {
  return L.divIcon({
    className: '',
    html: `
      <div style="
        width:24px;
        height:24px;
        border-radius:50%;
        background:#38bdf8;
        border:4px solid white;
        box-shadow:0 0 16px rgba(56,189,248,0.9);
      "></div>
    `,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  })
}

function formatDateTime(value: string | null) {
  if (!value) return '-'

  return new Date(value).toLocaleString('id-ID', {
    dateStyle: 'medium',
    timeStyle: 'medium',
  })
}

function formatOfflineDuration(offlineSince: string | null, nowMs: number) {
  if (!offlineSince || nowMs === 0) return '-'

  const offlineTime = new Date(offlineSince).getTime()
  const diffMs = nowMs - offlineTime

  if (diffMs < 0) return '-'

  const totalSeconds = Math.floor(diffMs / 1000)
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (days > 0) return `${days} hari ${hours} jam`
  if (hours > 0) return `${hours} jam ${minutes} menit`
  if (minutes > 0) return `${minutes} menit ${seconds} detik`

  return `${seconds} detik`
}

type NodeExtraFields = NetworkNode & {
  customerName?: string | null
  customerPhone?: string | null
  customerAddress?: string | null
  odpSlotCapacity?: number | null
  pppoeUsername?: string | null
  onuInterface?: string | null
  onuRxPower?: number | null
}

function getExtraNode(node: NetworkNode) {
  return node as NodeExtraFields
}

type OdpPortCapacityState = 'unknown' | 'available' | 'medium' | 'low' | 'full'

interface OdpPortCapacityInfo {
  capacity: number | null
  used: number
  remaining: number | null
  usagePercent: number
  state: OdpPortCapacityState
  label: string
  shortLabel: string
  markerColor: string
}

function calculateOdpPortCapacity(
  odpNode: NetworkNode,
  clientCount: number,
): OdpPortCapacityInfo | null {
  if (odpNode.type !== 'ODP') return null

  const extraNode = getExtraNode(odpNode)
  const capacity =
    typeof extraNode.odpSlotCapacity === 'number' &&
    extraNode.odpSlotCapacity > 0
      ? extraNode.odpSlotCapacity
      : null
  const used = clientCount

  if (capacity === null) {
    return {
      capacity,
      used,
      remaining: null,
      usagePercent: 0,
      state: 'unknown',
      label: 'Kapasitas belum diatur',
      shortLabel: '',
      markerColor: '#64748b',
    }
  }

  const remaining = Math.max(capacity - used, 0)
  const usagePercent = Math.min(100, Math.round((used / capacity) * 100))

  if (used >= capacity) {
    return {
      capacity,
      used,
      remaining,
      usagePercent,
      state: 'full',
      label: 'FULL / Port penuh',
      shortLabel: 'FULL',
      markerColor: '#db2777',
    }
  }

  if (usagePercent >= 75) {
    return {
      capacity,
      used,
      remaining,
      usagePercent,
      state: 'low',
      label: 'Sisa port sedikit',
      shortLabel: 'LOW',
      markerColor: '#7c3aed',
    }
  }

  if (usagePercent >= 50) {
    return {
      capacity,
      used,
      remaining,
      usagePercent,
      state: 'medium',
      label: 'Mulai terisi',
      shortLabel: '',
      markerColor: '#2563eb',
    }
  }

  return {
    capacity,
    used,
    remaining,
    usagePercent,
    state: 'available',
    label: 'Sisa port banyak',
    shortLabel: '',
    markerColor: '#06b6d4',
  }
}

function getClientDisplayName(node: NetworkNode) {
  const extraNode = getExtraNode(node)

  return extraNode.customerName || node.name
}

function formatSignalValue(node: NetworkNode) {
  const extraNode = getExtraNode(node)
  const rxPower = node.rxPower ?? extraNode.onuRxPower ?? null

  if (rxPower === null || rxPower === undefined) return '-'

  return `${rxPower} dBm`
}

function formatLatencyValue(value: number | null) {
  if (value === null || value === undefined) return '-'

  return `${value} ms`
}

function getCableTypeLabel(type: string) {
  if (type === 'BACKBONE') return 'Backbone'
  if (type === 'DISTRIBUTION') return 'Distribution'
  if (type === 'DROP_WIRE') return 'Drop Wire'
  return type
}

function getCableStatusLabel(status: string) {
  if (status === 'NORMAL') return 'Normal'
  if (status === 'AFFECTED') return 'Terdampak'
  if (status === 'BROKEN') return 'Putus'
  return 'Unknown'
}

function normalizeNodeSearchText(value: string) {
  return value.toLowerCase().replace(/[\s_-]+/g, ' ').trim()
}

function matchesManualCableNodeSearch(node: NetworkNode, keyword: string) {
  const query = normalizeNodeSearchText(keyword)

  if (!query) return true

  const extraNode = getExtraNode(node)
  const searchableText = normalizeNodeSearchText(
    [
      node.id,
      node.name,
      node.type,
      node.status,
      node.ipAddress,
      extraNode.customerName,
      extraNode.pppoeUsername,
      extraNode.onuInterface,
    ]
      .filter(Boolean)
      .join(' '),
  )

  return searchableText.includes(query)
}

function normalizeCableRouteCoordinates(coordinates: Cable['coordinates']): CableRouteCoordinate[] {
  if (!Array.isArray(coordinates)) return []

  return coordinates
    .map((point) => {
      if (!Array.isArray(point) || point.length < 2) return null

      const latitude = Number(point[0])
      const longitude = Number(point[1])

      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null

      return [latitude, longitude] as CableRouteCoordinate
    })
    .filter((point): point is CableRouteCoordinate => point !== null)
}

function suggestCableType(
  fromNode: NetworkNode | null,
  toNode: NetworkNode | null,
): CableTypeValue {
  if (!fromNode || !toNode) return 'DISTRIBUTION'

  if (fromNode.type === 'CLIENT' || toNode.type === 'CLIENT') {
    return 'DROP_WIRE'
  }

  if (fromNode.type === 'OLT' || toNode.type === 'OLT') {
    return 'BACKBONE'
  }

  return 'DISTRIBUTION'
}

function getPanelTitle(panel: SidebarPanel) {
  if (panel === 'search') return 'Pencarian'
  if (panel === 'alert') return 'Alert Gangguan'
  if (panel === 'filter') return 'Filter Map'
  if (panel === 'stats') return 'Statistik'
  if (panel === 'devices') return 'Perangkat Monitoring'
  return 'Panel'
}

function getStatusNotificationTitle(status: string) {
  if (status === 'ONLINE') return '🟢 ONLINE KEMBALI'
  if (status === 'OFFLINE') return '🔴 OFFLINE'
  if (status === 'WARNING') return '🟠 WARNING'
  return '⚪ STATUS BERUBAH'
}

function getStatusDescription(status: string, ipAddress: string | null) {
  const ipText = ipAddress ? ` - ${ipAddress}` : ''

  if (status === 'ONLINE') return `Online kembali${ipText}`
  if (status === 'OFFLINE') return `Offline${ipText}`
  if (status === 'WARNING') return `Warning${ipText}`
  return `Status berubah menjadi ${status}${ipText}`
}

function getStatusFromMonitoringLog(log: MonitoringLogRecord) {
  if (log.newStatus) return log.newStatus
  if (log.eventType === 'NODE_ONLINE') return 'ONLINE'
  if (log.eventType === 'NODE_OFFLINE') return 'OFFLINE'
  if (log.eventType === 'NODE_WARNING') return 'WARNING'

  return 'UNKNOWN'
}

function getMetadataString(metadata: unknown, key: string) {
  if (!metadata || typeof metadata !== 'object') return null

  const value = (metadata as Record<string, unknown>)[key]

  return typeof value === 'string' ? value : null
}

function mapMonitoringLogToHistoryItem(log: MonitoringLogRecord): OfflineNotification {
  const status = getStatusFromMonitoringLog(log)
  const ipAddress =
    log.node?.ipAddress || getMetadataString(log.metadata, 'ipAddress') || null

  return {
    id: log.id,
    nodeName: log.node?.name || 'Node tidak diketahui',
    ipAddress,
    status,
    message: log.message,
    time: new Date(log.createdAt).toLocaleString('id-ID', {
      dateStyle: 'short',
      timeStyle: 'medium',
    }),
  }
}

async function fetchMonitoringLogs() {
  const response = await fetch(`${API_BASE_URL}/api/monitoring-logs?limit=100`, {
    headers: getAuthorizedHeaders(),
  })

  if (!response.ok) {
    throw new Error('Gagal mengambil history log')
  }

  const data = (await response.json()) as { logs?: MonitoringLogRecord[] }

  return (data.logs || []).map(mapMonitoringLogToHistoryItem)
}

function getDeviceStatusLabel(status: NetworkDeviceRecord['connectionStatus']) {
  if (status === 'CONNECTED') return 'Terhubung'
  if (status === 'DISCONNECTED') return 'Terputus'
  if (status === 'ERROR') return 'Error'
  return 'Belum dites'
}

function NetworkDevicePanel() {
  const [devices, setDevices] = useState<NetworkDeviceRecord[]>([])
  const [loadingDevices, setLoadingDevices] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [testingDeviceId, setTestingDeviceId] = useState<string | null>(null)
  const [editingDeviceId, setEditingDeviceId] = useState<string | null>(null)
  const [isDeviceModalOpen, setIsDeviceModalOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [messageType, setMessageType] = useState<'success' | 'error'>('success')

  const [name, setName] = useState('')
  const [type, setType] = useState<NetworkDeviceRecord['type']>('MIKROTIK')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('8728')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [brand, setBrand] = useState('MikroTik')
  const [model, setModel] = useState('RouterOS')
  const [notes, setNotes] = useState('')
  const [isActive, setIsActive] = useState(true)

  const sortedDevices = useMemo(() => {
    return [...devices].sort((a, b) => {
      if (a.type !== b.type) return a.type.localeCompare(b.type)
      return a.name.localeCompare(b.name)
    })
  }, [devices])

  const activeCount = devices.filter((device) => device.isActive).length
  const mikrotikCount = devices.filter((device) => device.type === 'MIKROTIK').length
  const oltCount = devices.filter((device) => device.type === 'OLT').length

  const resetForm = useCallback(() => {
    setEditingDeviceId(null)
    setName('')
    setType('MIKROTIK')
    setHost('')
    setPort('8728')
    setUsername('')
    setPassword('')
    setBrand('MikroTik')
    setModel('RouterOS')
    setNotes('')
    setIsActive(true)
    setIsDeviceModalOpen(false)
  }, [])

  const refreshDevices = useCallback(async () => {
    try {
      setLoadingDevices(true)
      const response = await fetch(`${API_BASE_URL}/api/network-devices`, {
        headers: getAuthorizedHeaders(),
      })
      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.message || 'Gagal mengambil perangkat monitoring')
      }

      setDevices(data.devices || [])
    } catch (error) {
      setMessageType('error')
      setMessage(
        error instanceof Error
          ? error.message
          : 'Terjadi kesalahan saat mengambil perangkat monitoring.',
      )
    } finally {
      setLoadingDevices(false)
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refreshDevices()
    }, 0)

    return () => window.clearTimeout(timer)
  }, [refreshDevices])

  function handleOpenAddModal() {
    resetForm()
    setIsDeviceModalOpen(true)
  }

  function handleTypeChange(nextType: NetworkDeviceRecord['type']) {
    setType(nextType)

    if (!editingDeviceId) {
      if (nextType === 'MIKROTIK') {
        setPort('8728')
        setUsername('')
        setPassword('')
        setBrand('MikroTik')
        setModel('RouterOS')
      } else {
        setPort('161')
        setUsername('snmp')
        setPassword('public')
        setBrand('ZTE')
        setModel('C320')
      }
    }
  }

  function handleEditDevice(device: NetworkDeviceRecord) {
    setEditingDeviceId(device.id)
    setName(device.name)
    setType(device.type)
    setHost(device.host)
    setPort(String(device.port))
    setUsername(device.username)
    setPassword('')
    setBrand(device.brand || '')
    setModel(device.model || '')
    setNotes(device.notes || '')
    setIsActive(device.isActive)
    setMessage('')
    setIsDeviceModalOpen(true)
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setMessage('')

    const cleanName = name.trim()
    const cleanHost = host.trim()
    const cleanUsername = type === 'OLT' ? (username.trim() || 'snmp') : username.trim()
    const cleanPassword = password.trim()
    const parsedPort = Number(port)

    if (!cleanName) {
      setMessageType('error')
      setMessage('Nama perangkat wajib diisi.')
      return
    }

    if (!cleanHost) {
      setMessageType('error')
      setMessage('Host/IP perangkat wajib diisi.')
      return
    }

    if (!Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65535) {
      setMessageType('error')
      setMessage('Port harus berupa angka 1 sampai 65535.')
      return
    }

    if (type === 'MIKROTIK' && !cleanUsername) {
      setMessageType('error')
      setMessage('Username MikroTik wajib diisi.')
      return
    }

    if (!editingDeviceId && !cleanPassword) {
      setMessageType('error')
      setMessage(
        type === 'OLT'
          ? 'SNMP Community wajib diisi (misal: public).'
          : 'Password perangkat wajib diisi.',
      )
      return
    }

    try {
      setSubmitting(true)
      const response = await fetch(
        editingDeviceId
          ? `${API_BASE_URL}/api/network-devices/${editingDeviceId}`
          : `${API_BASE_URL}/api/network-devices`,
        {
          method: editingDeviceId ? 'PATCH' : 'POST',
          headers: getAuthorizedHeaders(true),
          body: JSON.stringify({
            name: cleanName,
            type,
            host: cleanHost,
            port: parsedPort,
            username: cleanUsername,
            ...(cleanPassword ? { password: cleanPassword } : {}),
            brand: brand.trim() || null,
            model: model.trim() || null,
            notes: notes.trim() || null,
            isActive,
          }),
        },
      )
      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.message || 'Gagal menyimpan perangkat monitoring')
      }

      setMessageType('success')
      setMessage(data.message || 'Perangkat monitoring berhasil disimpan.')
      resetForm()
      await refreshDevices()
    } catch (error) {
      setMessageType('error')
      setMessage(error instanceof Error ? error.message : 'Terjadi kesalahan.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDeleteDevice(device: NetworkDeviceRecord) {
    const confirmed = window.confirm(
      `Hapus/nonaktifkan perangkat ${device.name}?\n\nJika perangkat masih dipakai client, gunakan edit lalu nonaktifkan agar riwayat tetap aman.`,
    )

    if (!confirmed) return

    try {
      const response = await fetch(`${API_BASE_URL}/api/network-devices/${device.id}`, {
        method: 'DELETE',
        headers: getAuthorizedHeaders(),
      })
      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.message || 'Gagal menghapus perangkat monitoring')
      }

      setMessageType('success')
      setMessage(data.message || 'Perangkat monitoring berhasil dihapus.')
      await refreshDevices()
    } catch (error) {
      setMessageType('error')
      setMessage(error instanceof Error ? error.message : 'Terjadi kesalahan.')
    }
  }

  async function handleTestDevice(device: NetworkDeviceRecord) {
    try {
      setTestingDeviceId(device.id)
      setMessage('')

      const response = await fetch(
        `${API_BASE_URL}/api/network-devices/${device.id}/test`,
        {
          method: 'POST',
          headers: getAuthorizedHeaders(true),
        },
      )
      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.message || 'Gagal test koneksi perangkat')
      }

      setMessageType(data.success ? 'success' : 'error')
      setMessage(data.message || 'Test koneksi selesai.')
      await refreshDevices()
    } catch (error) {
      setMessageType('error')
      setMessage(error instanceof Error ? error.message : 'Terjadi kesalahan saat test koneksi.')
    } finally {
      setTestingDeviceId(null)
    }
  }

  return (
    <div className="network-device-panel">
      <div className="device-summary-grid">
        <div>
          <span>Total</span>
          <strong>{devices.length}</strong>
        </div>
        <div>
          <span>Aktif</span>
          <strong>{activeCount}</strong>
        </div>
        <div>
          <span>MikroTik</span>
          <strong>{mikrotikCount}</strong>
        </div>
        <div>
          <span>OLT (SNMP)</span>
          <strong>{oltCount}</strong>
        </div>
      </div>

      <button
        type="button"
        className="add-device-main-btn"
        onClick={handleOpenAddModal}
        style={{
          width: '100%',
          padding: '10px',
          borderRadius: '10px',
          border: 'none',
          background: '#16a34a',
          color: '#ffffff',
          fontWeight: 'bold',
          cursor: 'pointer',
        }}
      >
        + Tambah Perangkat
      </button>

      {message && (
        <div className={`admin-panel-message ${messageType}`}>
          {message}
        </div>
      )}

      {/* POPUP / MODAL FORM PERANGKAT (ADD & EDIT) */}
      {isDeviceModalOpen && (
        <div className="app-modal-backdrop">
          <div className="app-modal app-modal-form">
            <div className="app-modal-header">
              <div>
                <h2>{editingDeviceId ? 'Edit Perangkat' : 'Tambah Perangkat'}</h2>
                <p>
                  {type === 'OLT'
                    ? 'Koneksi OLT via SNMP UDP Port 161'
                    : 'Koneksi MikroTik via RouterOS API Port 8728'}
                </p>
              </div>
              <button type="button" className="app-modal-close" onClick={resetForm}>
                ×
              </button>
            </div>

            <form className="device-form" onSubmit={handleSubmit} style={{ padding: '14px' }}>
              <label>Jenis Perangkat</label>
              <select
                value={type}
                onChange={(event) =>
                  handleTypeChange(event.target.value as NetworkDeviceRecord['type'])
                }
              >
                <option value="MIKROTIK">MikroTik (RouterOS API)</option>
                <option value="OLT">OLT (SNMP v2c)</option>
              </select>

              <label>Nama Perangkat</label>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={type === 'OLT' ? 'Contoh: OLT ZTE Balen Central' : 'Contoh: MikroTik Mayang Kawis'}
              />

              <div className="device-form-row">
                <label>
                  Host / IP
                  <input
                    value={host}
                    onChange={(event) => setHost(event.target.value)}
                    placeholder="10.103.99.45"
                  />
                </label>
                <label>
                  Port
                  <input
                    value={port}
                    onChange={(event) => setPort(event.target.value)}
                    placeholder={type === 'MIKROTIK' ? '8728' : '161'}
                    inputMode="numeric"
                  />
                </label>
              </div>

              {type === 'MIKROTIK' ? (
                <>
                  <label>Username</label>
                  <input
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    placeholder="Username API MikroTik"
                  />

                  <label>Password</label>
                  <input
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder={
                      editingDeviceId
                        ? 'Kosongkan jika tidak ingin mengganti password'
                        : 'Password akun MikroTik'
                    }
                  />
                </>
              ) : (
                <>
                  <label>SNMP Community (Read-Only)</label>
                  <input
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder={
                      editingDeviceId
                        ? 'Kosongkan jika tidak ingin mengubah community'
                        : 'Default: public'
                    }
                  />
                  <small style={{ color: '#94a3b8', fontSize: '11px', marginTop: '-4px' }}>
                    Community string yang diset di OLT untuk hak akses snmpwalk/get.
                  </small>
                </>
              )}

              <div className="device-form-row">
                <label>
                  Brand
                  <input
                    value={brand}
                    onChange={(event) => setBrand(event.target.value)}
                    placeholder={type === 'OLT' ? 'ZTE / Huawei / HSGQ' : 'MikroTik'}
                  />
                </label>
                <label>
                  Model
                  <input
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                    placeholder={type === 'OLT' ? 'C320 / C300' : 'RouterOS'}
                  />
                </label>
              </div>

              <label>Catatan</label>
              <textarea
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="Catatan lokasi atau konfigurasi"
                rows={2}
              />

              <label className="device-checkbox-row">
                <input
                  type="checkbox"
                  checked={isActive}
                  onChange={(event) => setIsActive(event.target.checked)}
                />
                Perangkat aktif dipakai monitoring
              </label>

              <button type="submit" disabled={submitting}>
                {submitting
                  ? 'Menyimpan...'
                  : editingDeviceId
                    ? 'Simpan Perubahan'
                    : 'Tambah Perangkat'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* DAFTAR PERANGKAT DI SIDEBAR */}
      <div className="device-list-card">
        <div className="device-list-header">
          <h3>Daftar Perangkat</h3>
          <button type="button" onClick={() => void refreshDevices()} disabled={loadingDevices}>
            {loadingDevices ? 'Memuat...' : 'Refresh'}
          </button>
        </div>

        {sortedDevices.length === 0 ? (
          <p className="admin-empty-state">Belum ada MikroTik atau OLT terdaftar.</p>
        ) : (
          <div className="device-list">
            {sortedDevices.map((device) => (
              <div className="device-card" key={device.id}>
                <div className="device-card-top">
                  <div>
                    <strong>{device.name}</strong>
                    <span>
                      {device.type === 'OLT' ? 'OLT (SNMP)' : 'MikroTik (API)'} • {device.host}:{device.port}
                    </span>
                  </div>
                  <span
                    className={`device-status-pill status-${device.connectionStatus.toLowerCase()}`}
                  >
                    {getDeviceStatusLabel(device.connectionStatus)}
                  </span>
                </div>

                <div className="device-meta-grid">
                  {device.type === 'MIKROTIK' ? (
                    <>
                      <span>User: <b>{device.username}</b></span>
                      <span>Password: <b>{device.hasPassword ? 'Tersimpan' : 'Belum ada'}</b></span>
                    </>
                  ) : (
                    <span>Community: <b>{device.hasPassword ? 'Tersimpan' : 'public'}</b></span>
                  )}
                  <span>Brand: <b>{device.brand || '-'}</b></span>
                  <span>Model: <b>{device.model || '-'}</b></span>
                  <span>Aktif: <b>{device.isActive ? 'Ya' : 'Tidak'}</b></span>
                  <span>Terakhir: <b>{device.lastConnectedAt ? new Date(device.lastConnectedAt).toLocaleString('id-ID') : '-'}</b></span>
                </div>

                {device.lastConnectionMessage && (
                  <p className="device-message">{device.lastConnectionMessage}</p>
                )}

                <div className="device-card-actions">
                  <button type="button" onClick={() => handleEditDevice(device)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleTestDevice(device)}
                    disabled={testingDeviceId === device.id}
                  >
                    {testingDeviceId === device.id ? 'Testing...' : 'Test'}
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => void handleDeleteDevice(device)}
                  >
                    Hapus
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function getHistoryRowClass(status: string) {
  if (status === 'ONLINE') return 'history-row-online'
  if (status === 'OFFLINE') return 'history-row-offline'
  if (status === 'WARNING') return 'history-row-warning'
  return 'history-row-unknown'
}

export default function NetworkMap({ currentUser, onLogout }: NetworkMapProps) {
  const [nodes, setNodes] = useState<NetworkNode[]>([])
  const [cables, setCables] = useState<Cable[]>([])
  const [faultAlerts, setFaultAlerts] = useState<FaultAlert[]>([])
  const [selectedFaultAlert, setSelectedFaultAlert] =
    useState<FaultAlert | null>(null)

  const [offlineNotifications, setOfflineNotifications] = useState<
    OfflineNotification[]
  >([])
  const [statusHistory, setStatusHistory] = useState<OfflineNotification[]>([])

  const nodeStatusRef = useRef<Record<string, string>>({})

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [isPickingLocation, setIsPickingLocation] = useState(false)
  const [pickingLocationSource, setPickingLocationSource] =
    useState<PickingLocationSource>(null)
  const [selectedCoordinate, setSelectedCoordinate] =
    useState<SelectedCoordinate | null>(null)

  const [formLatitude, setFormLatitude] = useState('')
  const [formLongitude, setFormLongitude] = useState('')
  const [coordinateMessage, setCoordinateMessage] = useState('')

  const [editingNode, setEditingNode] = useState<NetworkNode | null>(null)
  const [editingClient, setEditingClient] = useState<NetworkNode | null>(null)
  const [isEditLocationMode, setIsEditLocationMode] = useState(false)
  const [mapMode, setMapMode] = useState<'street' | 'satellite'>('satellite')
  const [cableAnimationEnabled, setCableAnimationEnabled] = useState(false)

  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(true)
  const [activePanel, setActivePanel] = useState<SidebarPanel>('search')
  const [isAddNodeModalOpen, setIsAddNodeModalOpen] = useState(false)
  const [isAddClientModalOpen, setIsAddClientModalOpen] = useState(false)
  const [isAddCableModalOpen, setIsAddCableModalOpen] = useState(false)
  const [cableFromNodeId, setCableFromNodeId] = useState('')
  const [cableToNodeId, setCableToNodeId] = useState('')
  const [cableFromSearch, setCableFromSearch] = useState('')
  const [cableToSearch, setCableToSearch] = useState('')
  const [cableType, setCableType] = useState<CableTypeValue>('DISTRIBUTION')
  const [cableStatus, setCableStatus] = useState<CableStatusValue>('NORMAL')
  const [cableName, setCableName] = useState('')
  const [cableMessage, setCableMessage] = useState('')
  const [isCableSubmitting, setIsCableSubmitting] = useState(false)
  const [editingCableRoute, setEditingCableRoute] = useState<Cable | null>(null)
  const [editingCableRouteCoordinates, setEditingCableRouteCoordinates] =
    useState<CableRouteCoordinate[]>([])
  const [cableRouteMessage, setCableRouteMessage] = useState('')
  const [isCableRouteSubmitting, setIsCableRouteSubmitting] = useState(false)
  const [isHistoryModalOpen, setIsHistoryModalOpen] = useState(false)
  const [isAdminPanelOpen, setIsAdminPanelOpen] = useState(false)

  const isAdmin = currentUser.role === 'ADMIN'
  const canEditNetwork = isAdmin || currentUser.access === 'EDIT'
  const canDeleteNetwork = isAdmin
  const canManageUsers = isAdmin

  const effectiveEditLocationMode = canEditNetwork && isEditLocationMode

  const [searchKeyword, setSearchKeyword] = useState('')
  const [selectedSearchNode, setSelectedSearchNode] =
    useState<NetworkNode | null>(null)

  const [visibleNodeTypes, setVisibleNodeTypes] = useState({
    OLT: true,
    POLE: true,
    ODP: true,
    CLIENT: true,
    ROUTER: true,
  })

  const [visibleCableTypes, setVisibleCableTypes] = useState({
    BACKBONE: true,
    DISTRIBUTION: true,
    DROP_WIRE: true,
  })

  const [visibleStatuses, setVisibleStatuses] = useState({
    ONLINE: true,
    OFFLINE: true,
    WARNING: true,
    UNKNOWN: true,
  })

  const nodeMap = useMemo(() => {
    const map = new Map<string, NetworkNode>()
    for (let i = 0; i < nodes.length; i++) {
      map.set(nodes[i].id, nodes[i])
    }
    return map
  }, [nodes])

  const { odpClientsMap, odpCapacityMap } = useMemo(() => {
    const cMap = new Map<string, NetworkNode[]>()
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]
      if (node.type === 'CLIENT' && node.parentId) {
        const existing = cMap.get(node.parentId) || []
        existing.push(node)
        cMap.set(node.parentId, existing)
      }
    }

    const capMap = new Map<string, OdpPortCapacityInfo | null>()
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]
      if (node.type === 'ODP') {
        const clients = cMap.get(node.id) || []
        capMap.set(node.id, calculateOdpPortCapacity(node, clients.length))
      }
    }

    return { odpClientsMap: cMap, odpCapacityMap: capMap }
  }, [nodes])

  const manualCableNodeOptions = useMemo(() => {
    return nodes
      .filter((node) => ['OLT', 'POLE', 'ODP'].includes(node.type))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [nodes])

  const filteredCableFromNodeOptions = useMemo(() => {
    return manualCableNodeOptions.filter((node) =>
      matchesManualCableNodeSearch(node, cableFromSearch),
    )
  }, [manualCableNodeOptions, cableFromSearch])

  const filteredCableToNodeOptions = useMemo(() => {
    return manualCableNodeOptions
      .filter((node) => node.id !== cableFromNodeId)
      .filter((node) => matchesManualCableNodeSearch(node, cableToSearch))
  }, [manualCableNodeOptions, cableFromNodeId, cableToSearch])

  const cableFromNode = nodeMap.get(cableFromNodeId) || null
  const cableToNode = nodeMap.get(cableToNodeId) || null

  function handleCableFromNodeChange(nextFromNodeId: string) {
    setCableFromNodeId(nextFromNodeId)

    const nextFromNode = nodeMap.get(nextFromNodeId) || null
    setCableFromSearch(nextFromNode ? nextFromNode.name : '')

    if (nextFromNodeId === cableToNodeId) {
      setCableToNodeId('')
      setCableToSearch('')
      return
    }

    const nextToNode = nodeMap.get(cableToNodeId) || null

    if (nextFromNode && nextToNode) {
      setCableType(suggestCableType(nextFromNode, nextToNode))
    }
  }

  function handleCableToNodeChange(nextToNodeId: string) {
    setCableToNodeId(nextToNodeId)

    const nextFromNode = nodeMap.get(cableFromNodeId) || null
    const nextToNode = nodeMap.get(nextToNodeId) || null
    setCableToSearch(nextToNode ? nextToNode.name : '')

    if (nextFromNode && nextToNode) {
      setCableType(suggestCableType(nextFromNode, nextToNode))
    }
  }

  const center: [number, number] = [-7.1517, 111.883]

  const getFaultAlerts = useCallback(async (): Promise<FaultAlert[]> => {
    const response = await fetch(`${API_BASE_URL}/api/faults/analyze`)

    if (!response.ok) {
      throw new Error('Gagal mengambil analisa gangguan')
    }

    const data = await response.json()

    return data.alerts || []
  }, [])

  const refreshFaultAlerts = useCallback(async () => {
    try {
      const alerts = await getFaultAlerts()
      setFaultAlerts(alerts)
    } catch (error) {
      console.error(error)
    }
  }, [getFaultAlerts])

  const refreshMonitoringLogs = useCallback(async () => {
    try {
      const logs = await fetchMonitoringLogs()
      setStatusHistory(logs)
    } catch (error) {
      console.error(error)
    }
  }, [])

  const showStatusNotification = useCallback((node: NetworkNode) => {
    const notificationId = `${node.id}-${node.status}-${Date.now()}`

    const newNotification: OfflineNotification = {
      id: notificationId,
      nodeName: node.name,
      ipAddress: node.ipAddress || null,
      status: node.status,
      time: new Date().toLocaleTimeString('id-ID', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }),
    }

    setOfflineNotifications((previousNotifications) => [
      newNotification,
      ...previousNotifications.slice(0, 4),
    ])

    window.setTimeout(() => {
      setOfflineNotifications((previousNotifications) =>
        previousNotifications.filter(
          (notification) => notification.id !== notificationId,
        ),
      )
    }, 7000)
  }, [])

  useEffect(() => {
    async function loadInitialData() {
      try {
        const networkResponse = await fetch(`${API_BASE_URL}/api/network`)

        if (!networkResponse.ok) {
          throw new Error('Gagal mengambil data network dari backend')
        }

        const networkData = await networkResponse.json()
        const alerts = await getFaultAlerts()
        const monitoringLogs = await fetchMonitoringLogs()

        setNodes(networkData.nodes)
        setCables(networkData.cables)
        setFaultAlerts(alerts)
        setStatusHistory(monitoringLogs)

        nodeStatusRef.current = networkData.nodes.reduce(
          (result: Record<string, string>, node: NetworkNode) => {
            result[node.id] = node.status
            return result
          },
          {},
        )
      } catch (err) {
        console.error(err)
        setError('Backend belum bisa diakses atau API bermasalah')
      } finally {
        setLoading(false)
      }
    }

    loadInitialData()
  }, [getFaultAlerts])

  useEffect(() => {
    socket.on('connect', () => {
      console.log('Connected to realtime server:', socket.id)
    })

    socket.on('node-status-updated', (updatedNode: NetworkNode) => {
      const previousStatus = nodeStatusRef.current[updatedNode.id]
      nodeStatusRef.current[updatedNode.id] = updatedNode.status

      if (
        previousStatus &&
        updatedNode.status !== previousStatus &&
        ['ONLINE', 'OFFLINE', 'WARNING'].includes(updatedNode.status)
      ) {
        showStatusNotification(updatedNode)
      }

      setNodes((previousNodes) =>
        previousNodes.map((node) =>
          node.id === updatedNode.id ? updatedNode : node,
        ),
      )

      setEditingNode((currentEditingNode) => {
        if (!currentEditingNode) return currentEditingNode

        return currentEditingNode.id === updatedNode.id
          ? updatedNode
          : currentEditingNode
      })

      setEditingClient((currentEditingClient) => {
        if (!currentEditingClient) return currentEditingClient

        return currentEditingClient.id === updatedNode.id
          ? updatedNode
          : currentEditingClient
      })

      setSelectedSearchNode((currentSelectedNode) => {
        if (!currentSelectedNode) return currentSelectedNode

        return currentSelectedNode.id === updatedNode.id
          ? updatedNode
          : currentSelectedNode
      })

      refreshFaultAlerts()
    })

    socket.on('node-created', (newNode: NetworkNode) => {
      nodeStatusRef.current[newNode.id] = newNode.status

      setNodes((previousNodes) => {
        const alreadyExists = previousNodes.some(
          (node) => node.id === newNode.id,
        )

        if (alreadyExists) {
          return previousNodes
        }

        return [...previousNodes, newNode]
      })

      refreshFaultAlerts()
    })

    socket.on('node-deleted', (payload: { id: string }) => {
      delete nodeStatusRef.current[payload.id]

      setNodes((previousNodes) =>
        previousNodes.filter((node) => node.id !== payload.id),
      )

      setEditingNode((currentEditingNode) => {
        if (!currentEditingNode) return currentEditingNode

        return currentEditingNode.id === payload.id ? null : currentEditingNode
      })

      setEditingClient((currentEditingClient) => {
        if (!currentEditingClient) return currentEditingClient

        return currentEditingClient.id === payload.id ? null : currentEditingClient
      })

      setSelectedSearchNode((currentSelectedNode) => {
        if (!currentSelectedNode) return currentSelectedNode

        return currentSelectedNode.id === payload.id ? null : currentSelectedNode
      })

      refreshFaultAlerts()
    })

    socket.on('node-position-updated', (updatedNode: NetworkNode) => {
      setNodes((previousNodes) =>
        previousNodes.map((node) =>
          node.id === updatedNode.id ? updatedNode : node,
        ),
      )

      setEditingNode((currentEditingNode) => {
        if (!currentEditingNode) return currentEditingNode

        return currentEditingNode.id === updatedNode.id
          ? updatedNode
          : currentEditingNode
      })

      setEditingClient((currentEditingClient) => {
        if (!currentEditingClient) return currentEditingClient

        return currentEditingClient.id === updatedNode.id
          ? updatedNode
          : currentEditingClient
      })

      setSelectedSearchNode((currentSelectedNode) => {
        if (!currentSelectedNode) return currentSelectedNode

        return currentSelectedNode.id === updatedNode.id
          ? updatedNode
          : currentSelectedNode
      })

      refreshFaultAlerts()
    })

    socket.on('cable-status-updated', (updatedCable: Cable) => {
      setCables((previousCables) =>
        previousCables.map((cable) =>
          cable.id === updatedCable.id ? updatedCable : cable,
        ),
      )

      setEditingCableRoute((currentEditingCable) =>
        currentEditingCable?.id === updatedCable.id ? updatedCable : currentEditingCable,
      )

      refreshFaultAlerts()
    })

    socket.on('cable-created', (newCable: Cable) => {
      setCables((previousCables) => {
        const alreadyExists = previousCables.some(
          (cable) => cable.id === newCable.id,
        )

        if (alreadyExists) {
          return previousCables
        }

        return [...previousCables, newCable]
      })

      refreshFaultAlerts()
    })

    socket.on('cable-deleted', (payload: { id: string }) => {
      setCables((previousCables) =>
        previousCables.filter((cable) => cable.id !== payload.id),
      )

      setEditingCableRoute((currentEditingCable) =>
        currentEditingCable?.id === payload.id ? null : currentEditingCable,
      )

      refreshFaultAlerts()
    })

    socket.on('monitoring-log-created', (log: MonitoringLogRecord) => {
      const historyItem = mapMonitoringLogToHistoryItem(log)

      setStatusHistory((previousHistory) => [
        historyItem,
        ...previousHistory.filter((item) => item.id !== historyItem.id),
      ].slice(0, 100))
    })

    return () => {
      socket.off('connect')
      socket.off('node-status-updated')
      socket.off('node-created')
      socket.off('node-deleted')
      socket.off('node-position-updated')
      socket.off('cable-status-updated')
      socket.off('cable-created')
      socket.off('cable-deleted')
      socket.off('monitoring-log-created')
    }
  }, [refreshFaultAlerts, showStatusNotification])

  function handlePickLocation(coordinate: SelectedCoordinate) {
    setSelectedCoordinate(coordinate)
    setFormLatitude(String(coordinate.latitude))
    setFormLongitude(String(coordinate.longitude))
    setCoordinateMessage('Koordinat berhasil diambil dari peta. Marker biru bisa digeser jika titik belum tepat.')
    setIsPickingLocation(false)
    setPickingLocationSource(null)
  }

  function handleSelectedLocationDragEnd(event: L.DragEndEvent) {
    const marker = event.target
    const position = marker.getLatLng()

    const coordinate = {
      latitude: Number(position.lat.toFixed(7)),
      longitude: Number(position.lng.toFixed(7)),
    }

    setSelectedCoordinate(coordinate)
    setFormLatitude(String(coordinate.latitude))
    setFormLongitude(String(coordinate.longitude))
    setCoordinateMessage('Titik berhasil digeser. Latitude dan longitude sudah diperbarui.')
    setIsPickingLocation(false)
    setPickingLocationSource(null)
  }

  function handleClearSelectedLocation() {
    setSelectedCoordinate(null)
    setFormLatitude('')
    setFormLongitude('')
    setCoordinateMessage('Titik lokasi sudah dihapus. Silakan ambil titik ulang dari peta.')
    setIsPickingLocation(false)
    setPickingLocationSource(null)
  }

  function handleFormLatitudeChange(value: string) {
    setFormLatitude(value)

    const latitudeValue = Number(value)
    const longitudeValue = Number(formLongitude)

    if (value.trim() === '' || formLongitude.trim() === '') {
      setSelectedCoordinate(null)
      return
    }

    if (Number.isFinite(latitudeValue) && Number.isFinite(longitudeValue)) {
      setSelectedCoordinate({
        latitude: latitudeValue,
        longitude: longitudeValue,
      })
    }
  }

  function handleFormLongitudeChange(value: string) {
    setFormLongitude(value)

    const latitudeValue = Number(formLatitude)
    const longitudeValue = Number(value)

    if (formLatitude.trim() === '' || value.trim() === '') {
      setSelectedCoordinate(null)
      return
    }

    if (Number.isFinite(latitudeValue) && Number.isFinite(longitudeValue)) {
      setSelectedCoordinate({
        latitude: latitudeValue,
        longitude: longitudeValue,
      })
    }
  }

  function handleTogglePickingLocation(source: Exclude<PickingLocationSource, null> = 'node') {
    if (isPickingLocation && pickingLocationSource === source) {
      setIsPickingLocation(false)
      setPickingLocationSource(null)
      return
    }

    setIsPickingLocation(true)
    setPickingLocationSource(source)
    setCoordinateMessage('Mode ambil titik aktif. Klik lokasi di peta.')
  }

  function cancelPickingLocationIfNeeded(source: Exclude<PickingLocationSource, null>) {
    if (pickingLocationSource !== source) return

    setIsPickingLocation(false)
    setPickingLocationSource(null)
  }

  function handleAddNodeSuccess() {
    setSelectedCoordinate(null)
    setCoordinateMessage('')
    setActivePanel('alert')
    refreshFaultAlerts()
  }

  function handleAddClientSuccess(newNode: NetworkNode) {
    nodeStatusRef.current[newNode.id] = newNode.status

    setNodes((previousNodes) => {
      const alreadyExists = previousNodes.some((node) => node.id === newNode.id)

      if (alreadyExists) {
        return previousNodes.map((node) =>
          node.id === newNode.id ? newNode : node,
        )
      }

      return [...previousNodes, newNode]
    })

    setSelectedCoordinate(null)
    setFormLatitude('')
    setFormLongitude('')
    setCoordinateMessage('')
    setSelectedSearchNode(newNode)
    setActivePanel('search')
    refreshFaultAlerts()
  }

  async function handleAddCableSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setCableMessage('')

    if (!cableFromNodeId || !cableToNodeId) {
      setCableMessage('Node asal dan tujuan wajib dipilih.')
      return
    }

    if (cableFromNodeId === cableToNodeId) {
      setCableMessage('Node asal dan tujuan tidak boleh sama.')
      return
    }

    try {
      setIsCableSubmitting(true)

      const response = await fetch(`${API_BASE_URL}/api/cables`, {
        method: 'POST',
        headers: getAuthorizedHeaders(true),
        body: JSON.stringify({
          fromNodeId: cableFromNodeId,
          toNodeId: cableToNodeId,
          type: cableType,
          status: cableStatus,
          name: cableName.trim() || undefined,
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.message || 'Gagal menambahkan kabel')
      }

      if (data.cable) {
        setCables((previousCables) => {
          const alreadyExists = previousCables.some(
            (cable) => cable.id === data.cable.id,
          )

          if (alreadyExists) return previousCables

          return [...previousCables, data.cable]
        })
      }

      setCableFromNodeId('')
      setCableToNodeId('')
      setCableFromSearch('')
      setCableToSearch('')
      setCableName('')
      setCableType('DISTRIBUTION')
      setCableStatus('NORMAL')
      setCableMessage('')
      setIsAddCableModalOpen(false)
      refreshFaultAlerts()
    } catch (error) {
      setCableMessage(
        error instanceof Error
          ? error.message
          : 'Terjadi kesalahan saat menambahkan kabel.',
      )
    } finally {
      setIsCableSubmitting(false)
    }
  }

  async function handleDeleteCable(cableId: string) {
    const confirmDelete = window.confirm('Yakin ingin menghapus kabel ini?')

    if (!confirmDelete) return

    try {
      const response = await fetch(`${API_BASE_URL}/api/cables/${cableId}`, {
        method: 'DELETE',
        headers: getAuthorizedHeaders(),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.message || 'Gagal menghapus kabel')
      }

      setCables((previousCables) =>
        previousCables.filter((cable) => cable.id !== cableId),
      )

      if (selectedFaultAlert?.suspectedCableId === cableId) {
        setSelectedFaultAlert(null)
      }

      if (editingCableRoute?.id === cableId) {
        handleCancelCableRouteEdit()
      }

      refreshFaultAlerts()
    } catch (error) {
      if (error instanceof Error) {
        alert(error.message)
      } else {
        alert('Terjadi kesalahan saat menghapus kabel.')
      }
    }
  }

  function handleStartCableRouteEdit(cable: Cable) {
    const fromNode = nodeMap.get(cable.fromNodeId)
    const toNode = nodeMap.get(cable.toNodeId)
    const currentCoordinates = normalizeCableRouteCoordinates(cable.coordinates)

    let coordinates = currentCoordinates
    if (fromNode && toNode) {
      const bendPoints = currentCoordinates.length > 2 ? currentCoordinates.slice(1, -1) : []
      coordinates = [
        [fromNode.latitude, fromNode.longitude],
        ...bendPoints,
        [toNode.latitude, toNode.longitude],
      ]
    }

    if (coordinates.length < 2) {
      alert('Kabel belum memiliki titik awal dan akhir yang valid.')
      return
    }

    setIsPickingLocation(false)
    setPickingLocationSource(null)
    setEditingCableRoute(cable)
    setEditingCableRouteCoordinates(coordinates)
    setCableRouteMessage('Mode edit jalur aktif. Klik peta untuk menambah titik belokan sebelum titik tujuan.')
    setIsAddCableModalOpen(false)
  }

  function handleCancelCableRouteEdit() {
    setEditingCableRoute(null)
    setEditingCableRouteCoordinates([])
    setCableRouteMessage('')
    setIsCableRouteSubmitting(false)
  }

  function handleAddCableRoutePoint(coordinate: SelectedCoordinate) {
    if (!editingCableRoute) return

    setEditingCableRouteCoordinates((previousCoordinates) => {
      if (previousCoordinates.length < 2) return previousCoordinates

      const newPoint: CableRouteCoordinate = [coordinate.latitude, coordinate.longitude]
      const startPoint = previousCoordinates[0]
      const endPoint = previousCoordinates[previousCoordinates.length - 1]
      const bendPoints = previousCoordinates.slice(1, -1)

      return [startPoint, ...bendPoints, newPoint, endPoint]
    })

    setCableRouteMessage('Titik belokan ditambahkan. Klik Simpan Jalur jika sudah sesuai.')
  }

  function handleRemoveLastCableRoutePoint() {
    setEditingCableRouteCoordinates((previousCoordinates) => {
      if (previousCoordinates.length <= 2) return previousCoordinates

      const startPoint = previousCoordinates[0]
      const endPoint = previousCoordinates[previousCoordinates.length - 1]
      const bendPoints = previousCoordinates.slice(1, -2)

      return [startPoint, ...bendPoints, endPoint]
    })

    setCableRouteMessage('Titik belokan terakhir dihapus.')
  }

  function handleResetCableRouteToStraightLine() {
    if (!editingCableRoute) return

    const fromNode = nodeMap.get(editingCableRoute.fromNodeId)
    const toNode = nodeMap.get(editingCableRoute.toNodeId)

    if (!fromNode || !toNode) {
      alert('Node asal atau tujuan kabel tidak ditemukan.')
      return
    }

    setEditingCableRouteCoordinates([
      [fromNode.latitude, fromNode.longitude],
      [toNode.latitude, toNode.longitude],
    ])
    setCableRouteMessage('Jalur dikembalikan menjadi garis lurus.')
  }

  async function handleSaveCableRoute() {
    if (!editingCableRoute) return

    if (editingCableRouteCoordinates.length < 2) {
      setCableRouteMessage('Jalur kabel minimal memiliki titik awal dan titik akhir.')
      return
    }

    try {
      setIsCableRouteSubmitting(true)
      setCableRouteMessage('Menyimpan jalur kabel...')

      const response = await fetch(
        `${API_BASE_URL}/api/cables/${editingCableRoute.id}/route`,
        {
          method: 'PATCH',
          headers: getAuthorizedHeaders(true),
          body: JSON.stringify({
            coordinates: editingCableRouteCoordinates,
          }),
        },
      )

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.message || 'Gagal menyimpan jalur kabel')
      }

      setCables((previousCables) =>
        previousCables.map((cable) =>
          cable.id === data.cable.id ? data.cable : cable,
        ),
      )

      setEditingCableRoute(null)
      setEditingCableRouteCoordinates([])
      setCableRouteMessage('')
      refreshFaultAlerts()
    } catch (error) {
      setCableRouteMessage(
        error instanceof Error
          ? error.message
          : 'Terjadi kesalahan saat menyimpan jalur kabel.',
      )
    } finally {
      setIsCableRouteSubmitting(false)
    }
  }

  function handleEditNodeSuccess(updatedNode: NetworkNode) {
    nodeStatusRef.current[updatedNode.id] = updatedNode.status

    setNodes((previousNodes) =>
      previousNodes.map((node) =>
        node.id === updatedNode.id ? updatedNode : node,
      ),
    )

    setEditingNode(updatedNode)

    setSelectedSearchNode((currentSelectedNode) => {
      if (!currentSelectedNode) return currentSelectedNode

      return currentSelectedNode.id === updatedNode.id
        ? updatedNode
        : currentSelectedNode
    })

    refreshFaultAlerts()
  }

  function handleEditClientSuccess(updatedNode: NetworkNode) {
    nodeStatusRef.current[updatedNode.id] = updatedNode.status

    setNodes((previousNodes) =>
      previousNodes.map((node) =>
        node.id === updatedNode.id ? updatedNode : node,
      ),
    )

    setEditingClient(updatedNode)

    setSelectedSearchNode((currentSelectedNode) => {
      if (!currentSelectedNode) return currentSelectedNode

      return currentSelectedNode.id === updatedNode.id
        ? updatedNode
        : currentSelectedNode
    })

    refreshFaultAlerts()
  }

  function toggleNodeType(type: keyof typeof visibleNodeTypes) {
    setVisibleNodeTypes((previous) => ({
      ...previous,
      [type]: !previous[type],
    }))
  }

  function toggleCableType(type: keyof typeof visibleCableTypes) {
    setVisibleCableTypes((previous) => ({
      ...previous,
      [type]: !previous[type],
    }))
  }

  function toggleStatus(status: keyof typeof visibleStatuses) {
    setVisibleStatuses((previous) => ({
      ...previous,
      [status]: !previous[status],
    }))
  }

  async function handleDeleteNode(nodeId: string) {
    const confirmDelete = window.confirm(
      'Yakin ingin menghapus node ini? Kabel yang terhubung juga akan dihapus.',
    )

    if (!confirmDelete) return

    try {
      const response = await fetch(`${API_BASE_URL}/api/nodes/${nodeId}`, {
        method: 'DELETE',
        headers: getAuthorizedHeaders(),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.message || 'Gagal menghapus node')
      }

      delete nodeStatusRef.current[nodeId]

      setNodes((previousNodes) =>
        previousNodes.filter((node) => node.id !== nodeId),
      )

      if (Array.isArray(data.deletedCableIds)) {
        setCables((previousCables) =>
          previousCables.filter(
            (cable) => !data.deletedCableIds.includes(cable.id),
          ),
        )
      }

      if (editingNode?.id === nodeId) {
        setEditingNode(null)
      }

      if (selectedFaultAlert?.suspectedNodeId === nodeId) {
        setSelectedFaultAlert(null)
      }

      if (selectedSearchNode?.id === nodeId) {
        setSelectedSearchNode(null)
      }

      refreshFaultAlerts()
    } catch (error) {
      if (error instanceof Error) {
        alert(error.message)
      } else {
        alert('Terjadi kesalahan saat menghapus node.')
      }
    }
  }

  async function handleMarkerDragEnd(nodeId: string, event: L.DragEndEvent) {
    const marker = event.target
    const position = marker.getLatLng()

    const latitude = Number(position.lat.toFixed(7))
    const longitude = Number(position.lng.toFixed(7))

    try {
      const response = await fetch(
        `${API_BASE_URL}/api/nodes/${nodeId}/position`,
        {
          method: 'PATCH',
          headers: getAuthorizedHeaders(true),
          body: JSON.stringify({
            latitude,
            longitude,
          }),
        },
      )

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.message || 'Gagal memperbarui posisi marker')
      }

      setNodes((previousNodes) =>
        previousNodes.map((node) => (node.id === nodeId ? data.node : node)),
      )

      if (Array.isArray(data.cables)) {
        setCables((previousCables) =>
          previousCables.map((cable) => {
            const updatedCable = data.cables.find(
              (item: Cable) => item.id === cable.id,
            )

            return updatedCable || cable
          }),
        )
      }

      if (editingNode?.id === nodeId) {
        setEditingNode(data.node)
      }

      if (selectedSearchNode?.id === nodeId) {
        setSelectedSearchNode(data.node)
      }

      refreshFaultAlerts()
    } catch (error) {
      if (error instanceof Error) {
        alert(error.message)
      } else {
        alert('Terjadi kesalahan saat menggeser marker.')
      }
    }
  }

  const filteredNodes = useMemo(() => {
    return nodes.filter(
      (node) => visibleNodeTypes[node.type] && visibleStatuses[node.status],
    )
  }, [nodes, visibleNodeTypes, visibleStatuses])

  const offlineNodes = useMemo(
    () => nodes.filter((node) => node.status === 'OFFLINE'),
    [nodes],
  )

  const selectedFaultNode = selectedFaultAlert?.suspectedNodeId
    ? nodeMap.get(selectedFaultAlert.suspectedNodeId) || null
    : null

  const focusedNode = selectedSearchNode || selectedFaultNode
  const defaultMapNode = useMemo(() => {
    return (
      nodes.find(
        (node) =>
          node.type === 'OLT' &&
          normalizeNodeSearchText(node.name).includes('balen'),
      ) ||
      nodes.find((node) => node.type === 'OLT') ||
      nodes.find((node) => normalizeNodeSearchText(node.name).includes('olt')) ||
      null
    )
  }, [nodes])

  const normalizedSearchKeyword = searchKeyword.trim().toLowerCase()

  const searchResults = useMemo(() => {
    if (normalizedSearchKeyword.length < 2) return []

    return nodes
      .filter((node) => {
        const searchableText = [
          node.name,
          node.id,
          node.type,
          node.status,
          node.ipAddress || '',
          node.pppoeUsername || '',
        ]
          .join(' ')
          .toLowerCase()

        return searchableText.includes(normalizedSearchKeyword)
      })
      .slice(0, 20)
  }, [nodes, normalizedSearchKeyword])

  const stats = useMemo(() => {
    const totalNodes = nodes.length
    const totalCables = cables.length
    let totalClients = 0
    let onlineClients = 0
    let offlineClients = 0
    let warningClients = 0
    let unknownClients = 0
    let totalOdps = 0
    let totalOlts = 0
    let totalPoles = 0
    let totalRouters = 0

    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]
      if (n.type === 'CLIENT') {
        totalClients++
        if (n.status === 'ONLINE') onlineClients++
        else if (n.status === 'OFFLINE') offlineClients++
        else if (n.status === 'WARNING') warningClients++
        else unknownClients++
      } else if (n.type === 'ODP') totalOdps++
      else if (n.type === 'OLT') totalOlts++
      else if (n.type === 'POLE') totalPoles++
      else if (n.type === 'ROUTER') totalRouters++
    }

    let normalCables = 0
    let brokenCables = 0
    let affectedCables = 0
    for (let i = 0; i < cables.length; i++) {
      const c = cables[i]
      if (c.status === 'NORMAL') normalCables++
      else if (c.status === 'BROKEN') brokenCables++
      else if (c.status === 'AFFECTED') affectedCables++
    }

    return {
      totalNodes,
      totalCables,
      totalClients,
      onlineClients,
      offlineClients,
      warningClients,
      unknownClients,
      totalOdps,
      totalOlts,
      totalPoles,
      totalRouters,
      normalCables,
      brokenCables,
      affectedCables,
    }
  }, [nodes, cables])

  if (loading) {
    return <div className="loading-page">Memuat data peta...</div>
  }

  if (error) {
    return <div className="error-page">{error}</div>
  }

  const renderNodeMarker = (node: NetworkNode) => {
    const capacityInfo = odpCapacityMap.get(node.id) || null
    const isHighlighted =
      selectedFaultAlert?.suspectedNodeId === node.id ||
      selectedSearchNode?.id === node.id

    return (
      <Marker
        key={node.id}
        position={[node.latitude, node.longitude]}
        icon={createMarkerIcon(node, isHighlighted, capacityInfo)}
        draggable={effectiveEditLocationMode}
        eventHandlers={
          effectiveEditLocationMode
            ? {
                dragend: (event) => handleMarkerDragEnd(node.id, event),
              }
            : undefined
        }
      >
        <Popup>
          <div className="marker-popup marker-popup-compact">
            <div className="popup-title-row">
              <strong>{node.name}</strong>
              <span className={`node-status-pill status-${node.status.toLowerCase()}`}>
                {node.status}
              </span>
            </div>

            <div className="popup-subtitle">
              {node.type} • {node.id}
            </div>

            {(node.type === 'CLIENT' || node.type === 'ROUTER') && (() => {
              const extraNode = getExtraNode(node)
              const parentNode = node.parentId
                ? nodeMap.get(node.parentId) || null
                : null

              return (
                <>
                  <div className="popup-row">
                    <span>Nama</span>
                    <b>{getClientDisplayName(node)}</b>
                  </div>

                  <div className="popup-row">
                    <span>No WA</span>
                    <b>{extraNode.customerPhone || '-'}</b>
                  </div>

                  <div className="popup-row">
                    <span>Alamat</span>
                    <b className="popup-long-text">
                      {extraNode.customerAddress || '-'}
                    </b>
                  </div>

                  <div className="popup-row">
                    <span>PPPoE</span>
                    <b>{node.pppoeUsername || '-'}</b>
                  </div>

                  <div className="popup-row">
                    <span>ODP</span>
                    <b>{parentNode ? parentNode.name : '-'}</b>
                  </div>

                  <div className="popup-row">
                    <span>IP</span>
                    <b>{node.ipAddress || '-'}</b>
                  </div>

                  <div className="popup-row">
                    <span>RX / Latency</span>
                    <b>{formatSignalValue(node)} • {formatLatencyValue(node.latencyMs)}</b>
                  </div>

                  <div className="popup-row">
                    <span>Koordinat</span>
                    <a
                      className="popup-map-link"
                      href={`https://maps.google.com/?q=${node.latitude},${node.longitude}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Buka Maps
                    </a>
                  </div>

                  {node.status === 'OFFLINE' && (
                    <div className="popup-row popup-row-danger">
                      <span>Offline</span>
                      <OfflineDurationDisplay offlineSince={node.offlineSince} />
                    </div>
                  )}
                </>
              )
            })()}

            {node.type === 'ODP' && (() => {
              const clients = odpClientsMap.get(node.id) || []
              const onlineClientsList = clients.filter(
                (client) => client.status === 'ONLINE',
              )
              const offlineClientsList = clients.filter(
                (client) => client.status === 'OFFLINE',
              )
              const warningClientsList = clients.filter(
                (client) => client.status === 'WARNING',
              )
              const odpCapacity = capacityInfo?.capacity ?? null
              const usedSlots = capacityInfo?.used ?? clients.length
              const remainingSlots = capacityInfo?.remaining ?? null
              const usagePercent = capacityInfo?.usagePercent ?? 0
              const capacityState = capacityInfo?.state ?? 'unknown'
              const capacityLabel =
                capacityInfo?.label ?? 'Kapasitas belum diatur'

              return (
                <div className="odp-client-box odp-client-box-compact">
                  <div className="odp-capacity-grid">
                    <div>
                      <span>Kapasitas</span>
                      <b>{odpCapacity === null ? 'Belum diatur' : `${odpCapacity} slot`}</b>
                    </div>

                    <div>
                      <span>Terpakai</span>
                      <b>{usedSlots}</b>
                    </div>

                    <div>
                      <span>Sisa</span>
                      <b>{remainingSlots === null ? '-' : remainingSlots}</b>
                    </div>
                  </div>

                  <div className={`odp-port-status odp-port-status-${capacityState}`}>
                    {capacityLabel}
                  </div>

                  {odpCapacity !== null && (
                    <div className={`odp-capacity-bar odp-capacity-bar-${capacityState}`}>
                      <span style={{ width: `${usagePercent}%` }} />
                    </div>
                  )}

                  <div className="odp-client-summary-text">
                    Client: {clients.length} • Online: {onlineClientsList.length} • Offline:{' '}
                    {offlineClientsList.length} • Warning: {warningClientsList.length}
                  </div>

                  {clients.length === 0 && (
                    <p className="odp-empty-client">
                      Belum ada client yang terhubung ke ODP ini.
                    </p>
                  )}

                  {clients.length > 0 && (
                    <div className="odp-client-list odp-client-list-compact">
                      {clients.slice(0, 8).map((client) => {
                        const clientExtra = getExtraNode(client)

                        return (
                          <button
                            type="button"
                            className={`odp-client-item client-${client.status.toLowerCase()}`}
                            key={client.id}
                            onClick={() => {
                              setSelectedSearchNode(client)
                              setSelectedFaultAlert(null)
                            }}
                          >
                            <span className="odp-client-name">
                              {getClientDisplayName(client)}
                            </span>
                            <span className="odp-client-meta">
                              {client.status} • {client.pppoeUsername || clientExtra.customerPhone || '-'}
                            </span>
                          </button>
                        )
                      })}

                      {clients.length > 8 && (
                        <small className="odp-client-more">
                          +{clients.length - 8} client lainnya
                        </small>
                      )}
                    </div>
                  )}
                </div>
              )
            })()}

            {node.type !== 'CLIENT' &&
              node.type !== 'ROUTER' &&
              node.type !== 'ODP' && (
                <div className="popup-row">
                  <span>Status</span>
                  <b>{node.status}</b>
                </div>
              )}

            <small>
              {canEditNetwork
                ? effectiveEditLocationMode
                  ? 'Geser marker untuk mengubah posisi.'
                  : 'Aktifkan Mode Edit Lokasi untuk menggeser marker.'
                : 'Akun VIEW hanya bisa melihat data.'}
            </small>

            {((node.type === 'CLIENT' || node.type === 'ROUTER')
              ? canEditNetwork
              : isAdmin) && (
              <button
                type="button"
                className="edit-node-button"
                onClick={() => {
                  if (node.type === 'CLIENT' || node.type === 'ROUTER') {
                    setEditingClient(node)
                    return
                  }

                  setEditingNode(node)
                }}
              >
                {node.type === 'CLIENT' || node.type === 'ROUTER'
                  ? 'Edit Client'
                  : 'Edit Node'}
              </button>
            )}

            {canDeleteNetwork && (
              <button
                type="button"
                className="delete-node-button"
                onClick={() => handleDeleteNode(node.id)}
              >
                Hapus Node
              </button>
            )}
          </div>
        </Popup>
      </Marker>
    )
  }

  return (
    <div className="map-page">
      <div className="offline-toast-container">
        {offlineNotifications.map((notification) => (
          <div
            className={`offline-toast status-toast-${notification.status.toLowerCase()}`}
            key={notification.id}
          >
            <div className="offline-toast-header">
              <strong>{getStatusNotificationTitle(notification.status)}</strong>

              <button
                type="button"
                onClick={() =>
                  setOfflineNotifications((previousNotifications) =>
                    previousNotifications.filter(
                      (item) => item.id !== notification.id,
                    ),
                  )
                }
              >
                ×
              </button>
            </div>

            <div className="offline-toast-body">
              <b>{notification.nodeName}</b>
              <span>IP: {notification.ipAddress || '-'}</span>
              <span>Waktu: {notification.time}</span>
            </div>
          </div>
        ))}
      </div>

      <button
        type="button"
        className={
          isSidebarCollapsed
            ? 'sidebar-toggle collapsed'
            : 'sidebar-toggle expanded'
        }
        onClick={() =>
          setIsSidebarCollapsed((previousValue) => !previousValue)
        }
      >
        {isSidebarCollapsed ? '☰' : '×'}
      </button>

      {!isSidebarCollapsed && (
        <div className="sidebar">
          <div className="sidebar-top">
            <div>
              <h2>{getPanelTitle(activePanel)}</h2>
              <p className="sidebar-subtitle">Fiber Monitoring</p>
            </div>
          </div>

          <div className="sidebar-menu">
            <button
              type="button"
              className={activePanel === 'search' ? 'active' : ''}
              onClick={() => setActivePanel('search')}
            >
              Search
            </button>

            <button
              type="button"
              className={activePanel === 'alert' ? 'active' : ''}
              onClick={() => setActivePanel('alert')}
            >
              Alert
            </button>

            <button
              type="button"
              className={activePanel === 'filter' ? 'active' : ''}
              onClick={() => setActivePanel('filter')}
            >
              Filter
            </button>

            <button
              type="button"
              className={activePanel === 'stats' ? 'active' : ''}
              onClick={() => setActivePanel('stats')}
            >
              Stats
            </button>

            {canManageUsers && (
              <button
                type="button"
                className={activePanel === 'devices' ? 'active' : ''}
                onClick={() => setActivePanel('devices')}
              >
                Device
              </button>
            )}
          </div>

          <div className="sidebar-panel">
            {activePanel === 'devices' && canManageUsers && (
              <div className="sidebar-section">
                <NetworkDevicePanel />
              </div>
            )}

            {activePanel === 'search' && (
              <div className="sidebar-section">
                <div className="search-panel">
                  <h3>Pencarian Lokasi</h3>

                  <input
                    value={searchKeyword}
                    onChange={(event) => setSearchKeyword(event.target.value)}
                    placeholder="Cari ODP, client, PPPoE, IP..."
                    className="search-input"
                  />

                  {searchKeyword.trim().length > 0 &&
                    searchKeyword.trim().length < 2 && (
                      <p className="search-hint">Ketik minimal 2 huruf.</p>
                    )}

                  {searchResults.length > 0 && (
                    <div className="search-results">
                      {searchResults.map((node) => (
                        <button
                          type="button"
                          className={
                            selectedSearchNode?.id === node.id
                              ? 'search-result active'
                              : 'search-result'
                          }
                          key={node.id}
                          onClick={() => {
                            setSelectedSearchNode(node)
                            setSelectedFaultAlert(null)
                          }}
                        >
                          <strong>{node.name}</strong>
                          <span>
                            {node.type} • {node.status}
                          </span>
                          <small>
                            {node.pppoeUsername
                              ? `PPPoE: ${node.pppoeUsername}`
                              : `ID: ${node.id}`}
                          </small>
                        </button>
                      ))}
                    </div>
                  )}

                  {normalizedSearchKeyword.length >= 2 &&
                    searchResults.length === 0 && (
                      <p className="search-hint">Data tidak ditemukan.</p>
                    )}

                  {selectedSearchNode && (
                    <button
                      type="button"
                      className="clear-highlight-button"
                      onClick={() => {
                        setSelectedSearchNode(null)
                        setSearchKeyword('')
                      }}
                    >
                      Hapus Pencarian
                    </button>
                  )}
                </div>
              </div>
            )}

            {activePanel === 'alert' && (
              <>
                <div className="sidebar-section">
                  <div className="fault-panel">
                    <h3>Fault Analysis</h3>

                    {faultAlerts.length === 0 && (
                      <p className="safe-text">Tidak ada indikasi gangguan.</p>
                    )}

                    {faultAlerts.map((alert, index) => {
                      const isSelected =
                        selectedFaultAlert?.suspectedNodeId ===
                          alert.suspectedNodeId &&
                        selectedFaultAlert?.suspectedCableId ===
                          alert.suspectedCableId

                      return (
                        <div
                          className={`fault-card fault-${alert.severity.toLowerCase()} ${
                            isSelected ? 'fault-card-selected' : ''
                          }`}
                          key={`${alert.suspectedNodeId}-${alert.suspectedCableId}-${index}`}
                          onClick={() => {
                            setSelectedFaultAlert(alert)
                            setSelectedSearchNode(null)
                          }}
                        >
                          <div className="fault-header">
                            <strong>{alert.severity}</strong>
                            <span>{alert.affectedClients} client</span>
                          </div>

                          <h4>{alert.title}</h4>
                          <p>{alert.message}</p>

                          {alert.suspectedNodeName && (
                            <span>Node: {alert.suspectedNodeName}</span>
                          )}

                          {alert.suspectedCableName && (
                            <span>Kabel: {alert.suspectedCableName}</span>
                          )}

                          {alert.offlineClientNames.length > 0 && (
                            <small>
                              Client offline:{' '}
                              {alert.offlineClientNames.join(', ')}
                            </small>
                          )}
                        </div>
                      )
                    })}
                  </div>

                  {selectedFaultAlert && (
                    <button
                      type="button"
                      className="clear-highlight-button"
                      onClick={() => setSelectedFaultAlert(null)}
                    >
                      Hapus Highlight
                    </button>
                  )}
                </div>

                <div className="sidebar-section">
                  <h3>Alert Trouble</h3>

                  {offlineNodes.length === 0 && (
                    <p className="safe-text">Semua perangkat online.</p>
                  )}

                  {offlineNodes.map((node) => (
                    <div className="alert-card" key={node.id}>
                      <strong>{node.name}</strong>
                      <span>Status: {node.status}</span>
                      <span>IP: {node.ipAddress || '-'}</span>
                      <span>Signal: {node.rxPower ?? '-'} dBm</span>
                      <span>
                        Offline Sejak: {formatDateTime(node.offlineSince)}
                      </span>
                      <span>
                        Durasi:{' '}
                        <OfflineDurationDisplay offlineSince={node.offlineSince} />
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {activePanel === 'filter' && (
              <div className="sidebar-section">
                <div className="layer-filter">
                  <div className="filter-group">
                    <strong>Node</strong>

                    <label>
                      <input
                        type="checkbox"
                        checked={visibleNodeTypes.OLT}
                        onChange={() => toggleNodeType('OLT')}
                      />
                      OLT
                    </label>

                    <label>
                      <input
                        type="checkbox"
                        checked={visibleNodeTypes.POLE}
                        onChange={() => toggleNodeType('POLE')}
                      />
                      Tiang
                    </label>

                    <label>
                      <input
                        type="checkbox"
                        checked={visibleNodeTypes.ODP}
                        onChange={() => toggleNodeType('ODP')}
                      />
                      ODP
                    </label>

                    <label>
                      <input
                        type="checkbox"
                        checked={visibleNodeTypes.CLIENT}
                        onChange={() => toggleNodeType('CLIENT')}
                      />
                      Client
                    </label>

                    <label>
                      <input
                        type="checkbox"
                        checked={visibleNodeTypes.ROUTER}
                        onChange={() => toggleNodeType('ROUTER')}
                      />
                      Router
                    </label>
                  </div>

                  <div className="filter-group">
                    <strong>Status</strong>

                    <label>
                      <input
                        type="checkbox"
                        checked={visibleStatuses.ONLINE}
                        onChange={() => toggleStatus('ONLINE')}
                      />
                      Online
                    </label>

                    <label>
                      <input
                        type="checkbox"
                        checked={visibleStatuses.OFFLINE}
                        onChange={() => toggleStatus('OFFLINE')}
                      />
                      Offline
                    </label>

                    <label>
                      <input
                        type="checkbox"
                        checked={visibleStatuses.WARNING}
                        onChange={() => toggleStatus('WARNING')}
                      />
                      Warning
                    </label>

                    <label>
                      <input
                        type="checkbox"
                        checked={visibleStatuses.UNKNOWN}
                        onChange={() => toggleStatus('UNKNOWN')}
                      />
                      Unknown
                    </label>
                  </div>

                  <div className="filter-group">
                    <strong>Kabel</strong>

                    <label>
                      <input
                        type="checkbox"
                        checked={visibleCableTypes.BACKBONE}
                        onChange={() => toggleCableType('BACKBONE')}
                      />
                      Backbone
                    </label>

                    <label>
                      <input
                        type="checkbox"
                        checked={visibleCableTypes.DISTRIBUTION}
                        onChange={() => toggleCableType('DISTRIBUTION')}
                      />
                      Distribution
                    </label>

                    <label>
                      <input
                        type="checkbox"
                        checked={visibleCableTypes.DROP_WIRE}
                        onChange={() => toggleCableType('DROP_WIRE')}
                      />
                      Drop Wire
                    </label>
                  </div>
                </div>
              </div>
            )}

            {activePanel === 'stats' && (
              <div className="sidebar-section">
                <div className="stats-grid">
                  <div className="stat-card">
                    <span>Total Node</span>
                    <strong>{stats.totalNodes}</strong>
                  </div>

                  <div className="stat-card">
                    <span>Total Kabel</span>
                    <strong>{stats.totalCables}</strong>
                  </div>

                  <div className="stat-card">
                    <span>Total Client</span>
                    <strong>{stats.totalClients}</strong>
                  </div>

                  <div className="stat-card">
                    <span>Client Online</span>
                    <strong>{stats.onlineClients}</strong>
                  </div>

                  <div className="stat-card">
                    <span>Client Offline</span>
                    <strong>{stats.offlineClients}</strong>
                  </div>

                  <div className="stat-card">
                    <span>Client Warning</span>
                    <strong>{stats.warningClients}</strong>
                  </div>

                  <div className="stat-card">
                    <span>Client Unknown</span>
                    <strong>{stats.unknownClients}</strong>
                  </div>

                  <div className="stat-card">
                    <span>ODP</span>
                    <strong>{stats.totalOdps}</strong>
                  </div>

                  <div className="stat-card">
                    <span>OLT</span>
                    <strong>{stats.totalOlts}</strong>
                  </div>

                  <div className="stat-card">
                    <span>Tiang</span>
                    <strong>{stats.totalPoles}</strong>
                  </div>

                  <div className="stat-card">
                    <span>Router</span>
                    <strong>{stats.totalRouters}</strong>
                  </div>

                  <div className="stat-card">
                    <span>Kabel Normal</span>
                    <strong>{stats.normalCables}</strong>
                  </div>

                  <div className="stat-card">
                    <span>Kabel Terdampak</span>
                    <strong>{stats.affectedCables}</strong>
                  </div>

                  <div className="stat-card">
                    <span>Kabel Putus</span>
                    <strong>{stats.brokenCables}</strong>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {isAddNodeModalOpen && (
        <div
          className={`app-modal-backdrop ${
            isPickingLocation && pickingLocationSource === 'node'
              ? 'map-picking-hidden'
              : ''
          }`}
        >
          <div className="app-modal app-modal-form">
            <div className="app-modal-header">
              <div>
                <h2>Tambah Node</h2>
                <p>Input OLT, ODP, tiang, router, atau client baru.</p>
              </div>

              <button
                type="button"
                className="app-modal-close"
                onClick={() => {
                  cancelPickingLocationIfNeeded('node')
                  setIsAddNodeModalOpen(false)
                }}
              >
                ×
              </button>
            </div>

            <AddNodeForm
              latitude={formLatitude}
              longitude={formLongitude}
              coordinateMessage={coordinateMessage}
              isPickingLocation={isPickingLocation}
              parentOptions={manualCableNodeOptions}
              onLatitudeChange={handleFormLatitudeChange}
              onLongitudeChange={handleFormLongitudeChange}
              onTogglePickingLocation={() => handleTogglePickingLocation('node')}
              onClearLocation={handleClearSelectedLocation}
              onSuccess={() => {
                handleAddNodeSuccess()
                setIsAddNodeModalOpen(false)
              }}
            />
          </div>
        </div>
      )}

      {isAddClientModalOpen && (
        <div
          className={`app-modal-backdrop ${
            isPickingLocation && pickingLocationSource === 'client'
              ? 'map-picking-hidden'
              : ''
          }`}
        >
          <div className="app-modal app-modal-form">
            <div className="app-modal-header">
              <div>
                <h2>Tambah Client</h2>
                <p>Form khusus pelanggan untuk sales dan teknisi.</p>
              </div>

              <button
                type="button"
                className="app-modal-close"
                onClick={() => {
                  cancelPickingLocationIfNeeded('client')
                  setIsAddClientModalOpen(false)
                }}
              >
                ×
              </button>
            </div>

            <AddClientForm
              latitude={formLatitude}
              longitude={formLongitude}
              coordinateMessage={coordinateMessage}
              isPickingLocation={isPickingLocation}
              odpOptions={nodes.filter((node) => node.type === 'ODP')}
              currentUserName={currentUser.name}
              onLatitudeChange={handleFormLatitudeChange}
              onLongitudeChange={handleFormLongitudeChange}
              onTogglePickingLocation={() => handleTogglePickingLocation('client')}
              onClearLocation={handleClearSelectedLocation}
              onSuccess={(newNode) => {
                handleAddClientSuccess(newNode)
                setIsAddClientModalOpen(false)
              }}
            />
          </div>
        </div>
      )}

      {editingClient && (
        <div className="app-modal-backdrop">
          <div className="app-modal app-modal-form">
            <div className="app-modal-header">
              <div>
                <h2>Edit Client</h2>
                <p>{getClientDisplayName(editingClient)}</p>
              </div>

              <button
                type="button"
                className="app-modal-close"
                onClick={() => setEditingClient(null)}
              >
                ×
              </button>
            </div>

            <EditClientForm
              key={editingClient.id}
              node={editingClient}
              odpOptions={nodes.filter((node) => node.type === 'ODP')}
              onClose={() => setEditingClient(null)}
              onSuccess={handleEditClientSuccess}
            />
          </div>
        </div>
      )}

      {editingNode && (
        <div className="app-modal-backdrop">
          <div className="app-modal app-modal-form">
            <div className="app-modal-header">
              <div>
                <h2>Edit Node</h2>
                <p>{editingNode.name}</p>
              </div>

              <button
                type="button"
                className="app-modal-close"
                onClick={() => setEditingNode(null)}
              >
                ×
              </button>
            </div>

            <EditNodeForm
              key={editingNode.id}
              node={editingNode}
              parentOptions={manualCableNodeOptions}
              onClose={() => setEditingNode(null)}
              onSuccess={handleEditNodeSuccess}
            />
          </div>
        </div>
      )}

      {isAddCableModalOpen && isAdmin && (
        <div className="app-modal-backdrop">
          <div className="app-modal app-modal-form">
            <div className="app-modal-header">
              <div>
                <h2>Tambah Kabel</h2>
                <p>Hubungkan OLT, tiang, atau ODP secara manual.</p>
              </div>

              <button
                type="button"
                className="app-modal-close"
                onClick={() => {
                  setIsAddCableModalOpen(false)
                  setCableFromSearch('')
                  setCableToSearch('')
                }}
              >
                ×
              </button>
            </div>

            <form className="add-node-form add-cable-form" onSubmit={handleAddCableSubmit}>
              <div className="cable-node-select-block">
                <label htmlFor="cable-from-search">Node Asal</label>
                <input
                  id="cable-from-search"
                  className="cable-node-search-input"
                  value={cableFromSearch}
                  onChange={(event) => {
                    setCableFromSearch(event.target.value)
                    if (cableFromNodeId) setCableFromNodeId('')
                  }}
                  placeholder="Cari nama ODP / OLT / tiang asal..."
                />
                <select
                  value={cableFromNodeId}
                  onChange={(event) => handleCableFromNodeChange(event.target.value)}
                >
                  <option value="">Pilih node asal</option>
                  {filteredCableFromNodeOptions.map((node) => (
                    <option value={node.id} key={node.id}>
                      {node.name} — {node.type}
                    </option>
                  ))}
                </select>
                <small className="cable-node-search-info">
                  {filteredCableFromNodeOptions.length} dari {manualCableNodeOptions.length} node
                </small>
              </div>

              <div className="cable-node-select-block">
                <label htmlFor="cable-to-search">Node Tujuan</label>
                <input
                  id="cable-to-search"
                  className="cable-node-search-input"
                  value={cableToSearch}
                  onChange={(event) => {
                    setCableToSearch(event.target.value)
                    if (cableToNodeId) setCableToNodeId('')
                  }}
                  placeholder="Cari nama ODP / OLT / tiang tujuan..."
                />
                <select
                  value={cableToNodeId}
                  onChange={(event) => handleCableToNodeChange(event.target.value)}
                >
                  <option value="">Pilih node tujuan</option>
                  {filteredCableToNodeOptions.map((node) => (
                    <option value={node.id} key={node.id}>
                      {node.name} — {node.type}
                    </option>
                  ))}
                </select>
                <small className="cable-node-search-info">
                  {filteredCableToNodeOptions.length} node tersedia
                </small>
              </div>

              <label>
                Tipe Kabel
                <select
                  value={cableType}
                  onChange={(event) => setCableType(event.target.value as CableTypeValue)}
                >
                  <option value="BACKBONE">Backbone</option>
                  <option value="DISTRIBUTION">Distribution</option>
                  <option value="DROP_WIRE">Drop Wire</option>
                </select>
              </label>

              <label>
                Status Awal
                <select
                  value={cableStatus}
                  onChange={(event) => setCableStatus(event.target.value as CableStatusValue)}
                >
                  <option value="NORMAL">Normal</option>
                  <option value="AFFECTED">Terdampak</option>
                  <option value="BROKEN">Putus</option>
                  <option value="UNKNOWN">Unknown</option>
                </select>
              </label>

              <label>
                Nama Kabel <span className="form-label-note">opsional</span>
                <input
                  value={cableName}
                  onChange={(event) => setCableName(event.target.value)}
                  placeholder={
                    cableFromNode && cableToNode
                      ? `${getCableTypeLabel(cableType)} ${cableFromNode.name} ke ${cableToNode.name}`
                      : 'Otomatis dari node asal dan tujuan'
                  }
                />
              </label>

              <div className="cable-preview-box">
                <strong>Preview</strong>
                <span>
                  {cableFromNode ? cableFromNode.name : 'Node asal'} →{' '}
                  {cableToNode ? cableToNode.name : 'Node tujuan'}
                </span>
                <small>
                  {getCableTypeLabel(cableType)} • {getCableStatusLabel(cableStatus)}
                </small>
              </div>

              {cableMessage && <p className="form-message form-message-error">{cableMessage}</p>}

              <button type="submit" disabled={isCableSubmitting}>
                {isCableSubmitting ? 'Menyimpan...' : 'Simpan Kabel'}
              </button>
            </form>
          </div>
        </div>
      )}

      {isAdminPanelOpen && canManageUsers && (
        <AdminPanel onClose={() => setIsAdminPanelOpen(false)} />
      )}

      {isHistoryModalOpen && (
        <div className="app-modal-backdrop">
          <div className="app-modal history-modal">
            <div className="app-modal-header history-header">
              <div>
                <h2>History Log</h2>
                <p>Riwayat online/offline permanen dari database.</p>
              </div>

              <button
                type="button"
                className="app-modal-close"
                onClick={() => setIsHistoryModalOpen(false)}
              >
                ×
              </button>
            </div>

            {statusHistory.length === 0 ? (
              <p className="history-empty">Belum ada history online/offline tersimpan.</p>
            ) : (
              <div className="history-table">
                <div className="history-row history-row-head">
                  <span>Waktu</span>
                  <span>Nama</span>
                  <span>Keterangan</span>
                </div>

                {statusHistory.map((item) => (
                  <div
                    className={`history-row ${getHistoryRowClass(item.status)}`}
                    key={item.id}
                  >
                    <span>{item.time}</span>
                    <span>{item.nodeName}</span>
                    <span>{item.message || getStatusDescription(item.status, item.ipAddress)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="map-container">
        <div className="server-mini-card">
          <span>● NODE <b>{stats.totalNodes}</b></span>
          <span>● ONLINE <b>{stats.onlineClients}</b></span>
          <span>● OFFLINE <b>{stats.offlineClients}</b></span>
          <span>● ODP <b>{stats.totalOdps}</b></span>
        </div>

        {isPickingLocation && (
          <div className="map-pick-banner">
            Mode ambil titik aktif — klik lokasi baru atau geser marker biru
          </div>
        )}

        {effectiveEditLocationMode && (
          <div className="map-edit-banner">
            Mode Edit Lokasi Aktif — Marker bisa digeser dan posisi akan
            tersimpan.
          </div>
        )}

        <div className="map-mode-control">
          <div className="current-user-badge">
            {currentUser.name} • {currentUser.role} • {currentUser.access}
          </div>

          <button
            type="button"
            className={mapMode === 'street' ? 'active' : ''}
            onClick={() => setMapMode('street')}
          >
            Street
          </button>

          <button
            type="button"
            className={mapMode === 'satellite' ? 'active' : ''}
            onClick={() => setMapMode('satellite')}
          >
            Satellite
          </button>

          <button
            type="button"
            onClick={() => {
              setIsHistoryModalOpen(true)
              void refreshMonitoringLogs()
            }}
          >
            History
          </button>

          {canManageUsers && (
            <button
              type="button"
              onClick={() => setIsAdminPanelOpen(true)}
            >
              Admin Panel
            </button>
          )}

          {canManageUsers && (
            <button
              type="button"
              onClick={() => {
                setIsSidebarCollapsed(false)
                setActivePanel('devices')
              }}
            >
              Device
            </button>
          )}

          {canEditNetwork && (
            <button
              type="button"
              className="success"
              onClick={() => setIsAddClientModalOpen(true)}
            >
              + Client
            </button>
          )}

          {isAdmin && (
            <button
              type="button"
              className="success"
              onClick={() => setIsAddNodeModalOpen(true)}
            >
              + Node
            </button>
          )}

          {isAdmin && (
            <button
              type="button"
              className="success"
              onClick={() => setIsAddCableModalOpen(true)}
            >
              + Kabel
            </button>
          )}

          {canEditNetwork && (
            <button
              className={`map-action-btn edit-location-blue-btn ${isEditLocationMode ? 'active' : ''}`}
              onClick={() => setIsEditLocationMode((value) => !value)}
            >
              Edit Lokasi: {isEditLocationMode ? 'ON' : 'OFF'}
            </button>
          )}

          <button className="map-action-btn logout-red-btn" onClick={onLogout}>
            Logout
          </button>
        </div>

        <button
          type="button"
          className={`floating-cable-animation-button ${cableAnimationEnabled ? 'active' : ''}`}
          onClick={() => setCableAnimationEnabled((value) => !value)}
          title={
            cableAnimationEnabled
              ? 'Animasi kabel aktif. Klik untuk mode ringan.'
              : 'Mode ringan aktif. Klik untuk menyalakan animasi kabel.'
          }
          aria-label={cableAnimationEnabled ? 'Matikan animasi kabel' : 'Nyalakan animasi kabel'}
        >
          <span className="floating-cable-animation-icon">⚡</span>
          <span className="floating-cable-animation-text">{cableAnimationEnabled ? 'ON' : 'OFF'}</span>
        </button>

        {editingCableRoute && (
          <div className="cable-route-editor-panel">
            <div>
              <strong>Edit Jalur Kabel</strong>
              <span>{editingCableRoute.name}</span>
              <small>
                Titik belokan: {Math.max(editingCableRouteCoordinates.length - 2, 0)}
              </small>
              {cableRouteMessage && <small>{cableRouteMessage}</small>}
            </div>

            <div className="cable-route-editor-actions">
              <button
                type="button"
                onClick={handleRemoveLastCableRoutePoint}
                disabled={editingCableRouteCoordinates.length <= 2 || isCableRouteSubmitting}
              >
                Hapus Titik
              </button>

              <button
                type="button"
                onClick={handleResetCableRouteToStraightLine}
                disabled={isCableRouteSubmitting}
              >
                Luruskan
              </button>

              <button
                type="button"
                className="success"
                onClick={handleSaveCableRoute}
                disabled={isCableRouteSubmitting}
              >
                {isCableRouteSubmitting ? 'Menyimpan...' : 'Simpan Jalur'}
              </button>

              <button
                type="button"
                className="danger"
                onClick={handleCancelCableRouteEdit}
                disabled={isCableRouteSubmitting}
              >
                Batal
              </button>
            </div>
          </div>
        )}

        <MapContainer
          center={center}
          zoom={17}
          maxZoom={22}
          minZoom={5}
          preferCanvas={true}
          style={{ height: '100%', width: '100%' }}
        >
          <MapClickHandler
            isPickingLocation={isPickingLocation}
            onPickLocation={handlePickLocation}
            isEditingCablePath={Boolean(editingCableRoute)}
            onAddCablePathPoint={handleAddCableRoutePoint}
          />

          <MapDefaultCenterController
            defaultNode={defaultMapNode}
            targetNode={focusedNode}
            isPickingLocation={isPickingLocation}
            isEditingCablePath={Boolean(editingCableRoute)}
          />

          <MapFocusController targetNode={focusedNode} />

          <MapResizeController trigger={isSidebarCollapsed} />

          {mapMode === 'street' ? (
            <TileLayer
              attribution="Google Maps"
              url="https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}"
              maxZoom={22}
              maxNativeZoom={22}
            />
          ) : (
            <TileLayer
              attribution="Google Satellite"
              url="https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}"
              maxZoom={22}
              maxNativeZoom={22}
            />
          )}

          {/* Layer Kabel Efisien (Leaflet Native LayerGroup) */}
          <CableLayer
            cables={cables}
            nodeMap={nodeMap}
            visibleCableTypes={visibleCableTypes}
            selectedFaultAlertCableId={selectedFaultAlert?.suspectedCableId}
            cableAnimationEnabled={cableAnimationEnabled}
            isAdmin={isAdmin}
            onEditRoute={handleStartCableRouteEdit}
            onDeleteCable={handleDeleteCable}
          />

          {/* Garis Preview saat Admin Mengedit Jalur Kabel */}
          {editingCableRoute && (
            <Polyline
              positions={editingCableRouteCoordinates}
              pathOptions={{ color: '#0ea5e9', weight: 6, dashArray: '8 8' }}
            />
          )}

          <MarkerClusterGroup
            chunkedLoading={true}
            maxClusterRadius={80}
            disableClusteringAtZoom={19}
            spiderfyOnMaxZoom={true}
          >
            {filteredNodes.map(renderNodeMarker)}
          </MarkerClusterGroup>

          {selectedCoordinate && (
            <Marker
              position={[
                selectedCoordinate.latitude,
                selectedCoordinate.longitude,
              ]}
              icon={createSelectedLocationIcon()}
              draggable
              eventHandlers={{
                dragend: handleSelectedLocationDragEnd,
              }}
            >
              <Popup>
                Titik sementara
                <br />
                Lat: {selectedCoordinate.latitude}
                <br />
                Lng: {selectedCoordinate.longitude}
                <br />
                <small>Geser marker ini jika titik belum tepat.</small>
              </Popup>
            </Marker>
          )}
        </MapContainer>
      </div>
    </div>
  )
}