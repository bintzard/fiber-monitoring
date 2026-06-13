import { useEffect, useState } from 'react'
import type { NetworkNode } from '../types/network'
import { getAuthToken } from '../api/auth'

const API_BASE_URL = import.meta.env.VITE_API_URL || window.location.origin

function getAuthorizedJsonHeaders() {
  const token = getAuthToken()

  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

interface EditNodeFormProps {
  node: NetworkNode
  parentOptions: NetworkNode[]
  onClose: () => void
  onSuccess?: (node: NetworkNode) => void
}

type OdpEditableNode = NetworkNode & {
  odpSlotCapacity?: number | null
  odpInputPort?: string | null
  odpOutputPort?: string | null
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

function getParentLabel(type: NetworkNode['type']) {
  if (type === 'CLIENT') return 'Parent ODP / Induk Client'
  if (type === 'ROUTER') return 'Parent ODP / Induk Router'
  if (type === 'ODP') return 'Parent OLT / Tiang'
  if (type === 'POLE') return 'Parent OLT / Jalur'
  return 'Parent / Induk'
}

function getNamePlaceholder(type: NetworkNode['type']) {
  if (type === 'CLIENT') return 'Contoh: Client - Budi'
  if (type === 'ODP') return 'Contoh: ODP Balen 1'
  if (type === 'OLT') return 'Contoh: OLT_Server_Balen'
  if (type === 'POLE') return 'Contoh: Tiang Balen 1'
  if (type === 'ROUTER') return 'Contoh: Router Budi'
  return 'Nama node'
}

export default function EditNodeForm({
  node,
  parentOptions,
  onClose,
  onSuccess,
}: EditNodeFormProps) {
  const [name, setName] = useState(node.name)
  const [type, setType] = useState(node.type)
  const [ipAddress, setIpAddress] = useState(node.ipAddress || '')
  const [status, setStatus] = useState(node.status)

  const [rxPower, setRxPower] = useState(
    node.rxPower !== undefined && node.rxPower !== null
      ? String(node.rxPower)
      : '',
  )

  const [parentId, setParentId] = useState(node.parentId || '')
  const [pppoeUsername, setPppoeUsername] = useState(
    node.pppoeUsername || '',
  )
  const [monitoringEnabled, setMonitoringEnabled] = useState(
    node.monitoringEnabled || false,
  )
  const [monitoringMethod, setMonitoringMethod] = useState(
    node.monitoringMethod || 'MANUAL',
  )

  const editableOdpNode = node as OdpEditableNode
  const [odpSlotCapacity, setOdpSlotCapacity] = useState(
    editableOdpNode.odpSlotCapacity !== undefined &&
      editableOdpNode.odpSlotCapacity !== null
      ? String(editableOdpNode.odpSlotCapacity)
      : '',
  )
  const [odpInputPort, setOdpInputPort] = useState(
    editableOdpNode.odpInputPort || '',
  )
  const [odpOutputPort, setOdpOutputPort] = useState(
    editableOdpNode.odpOutputPort || '',
  )

  const [currentTimeMs, setCurrentTimeMs] = useState(() => Date.now())
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')

  const isClientLikeNode = type === 'CLIENT' || type === 'ROUTER'
  const isPassiveNode = type === 'ODP' || type === 'POLE' || type === 'OLT'

  useEffect(() => {
    const timer = window.setInterval(() => {
      setCurrentTimeMs(Date.now())
    }, 1000)

    return () => {
      window.clearInterval(timer)
    }
  }, [])

  function handleTypeChange(nextType: NetworkNode['type']) {
    setType(nextType)

    if (nextType === 'CLIENT' || nextType === 'ROUTER') {
      setMonitoringEnabled(true)

      if (monitoringMethod === 'MANUAL') {
        setMonitoringMethod('PPPOE')
      }

      return
    }

    setMonitoringEnabled(false)
    setMonitoringMethod('MANUAL')
    setPppoeUsername('')
    setIpAddress('')
    setRxPower('')

    if (nextType !== 'ODP') {
      setOdpSlotCapacity('')
      setOdpInputPort('')
      setOdpOutputPort('')
    }
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()

    setLoading(true)
    setMessage('')

    const finalMonitoringEnabled = isClientLikeNode
      ? monitoringEnabled
      : false

    const finalMonitoringMethod = isClientLikeNode
      ? monitoringMethod
      : 'MANUAL'

    const finalPppoeUsername = isClientLikeNode
      ? pppoeUsername || null
      : null

    const finalIpAddress = isClientLikeNode ? ipAddress || null : null

    const finalRxPower =
      isClientLikeNode && rxPower ? Number(rxPower) : null

    const finalOdpSlotCapacity =
      type === 'ODP' && odpSlotCapacity.trim()
        ? Number(odpSlotCapacity)
        : null

    try {
      const response = await fetch(`${API_BASE_URL}/api/nodes/${node.id}`, {
        method: 'PATCH',
        headers: getAuthorizedJsonHeaders(),
        body: JSON.stringify({
          name,
          type,
          ipAddress: finalIpAddress,
          status,
          rxPower: finalRxPower,
          parentId: parentId || null,
          pppoeUsername: finalPppoeUsername,
          monitoringEnabled: finalMonitoringEnabled,
          monitoringMethod: finalMonitoringMethod,
          odpSlotCapacity: type === 'ODP' ? finalOdpSlotCapacity : null,
          odpInputPort: type === 'ODP' ? odpInputPort || null : null,
          odpOutputPort: type === 'ODP' ? odpOutputPort || null : null,
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.message || 'Gagal memperbarui node')
      }

      setMessage('Data node berhasil diperbarui.')

      if (onSuccess) {
        onSuccess(data.node)
      }
    } catch (error) {
      if (error instanceof Error) {
        setMessage(error.message)
      } else {
        setMessage('Terjadi kesalahan saat memperbarui node.')
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <form className="edit-node-form" onSubmit={handleSubmit}>
      <div className="form-header-row">
        <h3>Edit Node</h3>

        <button type="button" className="close-form-button" onClick={onClose}>
          Tutup
        </button>
      </div>

      <p className="node-id-info">ID: {node.id}</p>

      <div className="form-section">
        <h4 className="form-section-title">Data Node</h4>

        <label>Nama Node</label>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={getNamePlaceholder(type)}
          required
        />

        <label>Tipe Node</label>
        <select
          value={type}
          onChange={(event) =>
            handleTypeChange(event.target.value as NetworkNode['type'])
          }
        >
          <option value="CLIENT">CLIENT / Pelanggan</option>
          <option value="ROUTER">ROUTER</option>
          <option value="ODP">ODP</option>
          <option value="POLE">POLE / Tiang</option>
          <option value="OLT">OLT</option>
        </select>

        <label>Status</label>
        <select
          value={status}
          onChange={(event) =>
            setStatus(event.target.value as NetworkNode['status'])
          }
        >
          <option value="ONLINE">ONLINE</option>
          <option value="OFFLINE">OFFLINE</option>
          <option value="WARNING">WARNING</option>
          <option value="UNKNOWN">UNKNOWN</option>
        </select>
      </div>

      <div className="form-divider"></div>

      <div className="form-section">
        <h4 className="form-section-title">Relasi / Induk</h4>

        <label>{getParentLabel(type)}</label>
        <select
          value={parentId}
          onChange={(event) => setParentId(event.target.value)}
        >
          <option value="">Tanpa Parent</option>

          {parentOptions
            .filter((parent) => parent.id !== node.id)
            .map((parent) => (
              <option key={parent.id} value={parent.id}>
                {parent.name} ({parent.type})
              </option>
            ))}
        </select>

        {type === 'CLIENT' && (
          <p className="form-helper-text">
            Untuk client, parent sebaiknya dipilih dari ODP tempat client
            tersebut terhubung.
          </p>
        )}

        {type === 'ODP' && (
          <>
            <p className="form-helper-text">
              Untuk ODP, parent bisa diarahkan ke OLT atau tiang/jalur utama.
            </p>

            <label>Kapasitas Slot ODP</label>
            <input
              type="number"
              min="0"
              value={odpSlotCapacity}
              onChange={(event) => setOdpSlotCapacity(event.target.value)}
              placeholder="Contoh: 8 atau 16"
            />

            <label>Port Input ODP</label>
            <input
              value={odpInputPort}
              onChange={(event) => setOdpInputPort(event.target.value)}
              placeholder="Opsional, contoh: IN-1"
            />

            <label>Port Output / Keterangan Port</label>
            <input
              value={odpOutputPort}
              onChange={(event) => setOdpOutputPort(event.target.value)}
              placeholder="Opsional, contoh: Port 1-8"
            />
          </>
        )}
      </div>

      <div className="form-divider"></div>

      <div className="form-section">
        <h4 className="form-section-title">Data Monitoring</h4>

        {isClientLikeNode && (
          <>
            <label>PPPoE Username</label>
            <input
              value={pppoeUsername}
              onChange={(event) => setPppoeUsername(event.target.value)}
              placeholder="Contoh: 3toko"
            />

            <label>Metode Monitoring</label>
            <select
              value={monitoringMethod}
              onChange={(event) =>
                setMonitoringMethod(
                  event.target.value as NetworkNode['monitoringMethod'],
                )
              }
            >
              <option value="MANUAL">MANUAL</option>
              <option value="PING">PING</option>
              <option value="PPPOE">PPPOE</option>
              <option value="OLT">OLT</option>
              <option value="SNMP">SNMP</option>
            </select>

            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={monitoringEnabled}
                onChange={(event) => setMonitoringEnabled(event.target.checked)}
              />
              Monitoring Aktif
            </label>

            <label>IP Address</label>
            <input
              value={ipAddress}
              onChange={(event) => setIpAddress(event.target.value)}
              placeholder="Otomatis dari PPPoE atau isi manual untuk PING"
            />

            <label>RX Power / Redaman</label>
            <input
              value={rxPower}
              onChange={(event) => setRxPower(event.target.value)}
              placeholder="Contoh: -22.5"
            />

            <p className="form-helper-text">
              Untuk metode PPPOE, status dan IP akan mengikuti data aktif dari
              MikroTik. RX Power nanti lebih akurat jika sudah terhubung ke OLT.
            </p>
          </>
        )}

        {isPassiveNode && (
          <div className="passive-node-info">
            <strong>Monitoring otomatis tidak aktif untuk node ini.</strong>
            <span>
              ODP, OLT, dan tiang sementara menggunakan metode MANUAL. Data
              client tetap dimonitor melalui PPPoE atau PING.
            </span>
          </div>
        )}

        <div className="monitoring-info-box">
          <span>Terakhir Dicek: {formatDateTime(node.lastCheckedAt)}</span>
          <span>Terakhir Online: {formatDateTime(node.lastSeenAt)}</span>
          <span>Offline Sejak: {formatDateTime(node.offlineSince)}</span>
          <span>
            Durasi Offline:{' '}
            {node.status === 'OFFLINE'
              ? formatOfflineDuration(node.offlineSince, currentTimeMs)
              : '-'}
          </span>
          <span>
            Latency:{' '}
            {node.latencyMs !== null && node.latencyMs !== undefined
              ? `${node.latencyMs} ms`
              : '-'}
          </span>
        </div>
      </div>

      <button type="submit" disabled={loading}>
        {loading ? 'Menyimpan...' : 'Simpan Perubahan'}
      </button>

      {message && <p className="form-message">{message}</p>}
    </form>
  )
}
