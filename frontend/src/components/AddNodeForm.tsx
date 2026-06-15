import { type FormEvent, useState } from 'react'
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

interface AddNodeFormProps {
  latitude: string
  longitude: string
  coordinateMessage: string
  isPickingLocation: boolean
  parentOptions: NetworkNode[]
  onLatitudeChange: (value: string) => void
  onLongitudeChange: (value: string) => void
  onTogglePickingLocation: () => void
  onClearLocation?: () => void
  onSuccess?: (node: NetworkNode) => void
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

function getIdPlaceholder(type: NetworkNode['type']) {
  if (type === 'CLIENT') return 'client-0001'
  if (type === 'ODP') return 'odp-0001'
  if (type === 'OLT') return 'olt-0001'
  if (type === 'POLE') return 'pole-0001'
  if (type === 'ROUTER') return 'router-0001'
  return 'node-0001'
}

export default function AddNodeForm({
  latitude,
  longitude,
  coordinateMessage,
  isPickingLocation,
  parentOptions,
  onLatitudeChange,
  onLongitudeChange,
  onTogglePickingLocation,
  onClearLocation,
  onSuccess,
}: AddNodeFormProps) {
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [type, setType] = useState<NetworkNode['type']>('CLIENT')
  const [ipAddress, setIpAddress] = useState('')
  const [status, setStatus] = useState<NetworkNode['status']>('ONLINE')
  const [rxPower, setRxPower] = useState('')
  const [parentId, setParentId] = useState('')

  const [pppoeUsername, setPppoeUsername] = useState('')
  const [monitoringEnabled, setMonitoringEnabled] = useState(true)
  const [monitoringMethod, setMonitoringMethod] =
    useState<NetworkNode['monitoringMethod']>('PPPOE')

  const [loading, setLoading] = useState(false)
  const [generatingId, setGeneratingId] = useState(false)
  const [message, setMessage] = useState('')

  const isClientLikeNode = type === 'CLIENT' || type === 'ROUTER'
  const isPassiveNode = type === 'ODP' || type === 'POLE' || type === 'OLT'

  function handleTypeChange(nextType: NetworkNode['type']) {
    setType(nextType)
    setMessage('')

    if (nextType === 'CLIENT' || nextType === 'ROUTER') {
      setMonitoringEnabled(true)
      setMonitoringMethod('PPPOE')
      setStatus('ONLINE')
      return
    }

    setMonitoringEnabled(false)
    setMonitoringMethod('MANUAL')
    setPppoeUsername('')
    setIpAddress('')
    setRxPower('')
    setStatus('UNKNOWN')
  }

  async function handleGenerateId() {
    setGeneratingId(true)
    setMessage('')

    try {
      const response = await fetch(
        `${API_BASE_URL}/api/nodes/generate-id/${type}`,
      )

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.message || 'Gagal membuat ID otomatis')
      }

      setId(data.id)
      setMessage(`ID otomatis dibuat: ${data.id}`)
    } catch (error) {
      if (error instanceof Error) {
        setMessage(error.message)
      } else {
        setMessage('Terjadi kesalahan saat membuat ID.')
      }
    } finally {
      setGeneratingId(false)
    }
  }

  async function handleSubmit(event: FormEvent) {
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

    try {
      const response = await fetch(`${API_BASE_URL}/api/nodes`, {
        method: 'POST',
        headers: getAuthorizedJsonHeaders(),
        body: JSON.stringify({
          id,
          name,
          type,
          ipAddress: finalIpAddress,
          latitude: Number(latitude),
          longitude: Number(longitude),
          status,
          rxPower: finalRxPower,
          parentId: parentId || null,
          pppoeUsername: finalPppoeUsername,
          monitoringEnabled: finalMonitoringEnabled,
          monitoringMethod: finalMonitoringMethod,
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.message || 'Gagal menambahkan node')
      }

      setMessage('Data berhasil ditambahkan.')

      setId('')
      setName('')
      setIpAddress('')
      setRxPower('')
      setParentId('')
      setPppoeUsername('')

      if (type === 'CLIENT' || type === 'ROUTER') {
        setMonitoringEnabled(true)
        setMonitoringMethod('PPPOE')
        setStatus('ONLINE')
      } else {
        setMonitoringEnabled(false)
        setMonitoringMethod('MANUAL')
        setStatus('UNKNOWN')
      }

      onLatitudeChange('')
      onLongitudeChange('')

      if (onSuccess) {
        onSuccess(data.node)
      }
    } catch (error) {
      if (error instanceof Error) {
        setMessage(error.message)
      } else {
        setMessage('Terjadi kesalahan.')
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <form className="add-node-form" onSubmit={handleSubmit}>
      <div className="form-header-row">
        <h3>Tambah Node</h3>
      </div>

      <div className="form-section">
        <h4 className="form-section-title">Data Node</h4>

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

        <label>ID Node</label>
        <div className="id-row">
          <input
            value={id}
            onChange={(event) => setId(event.target.value)}
            placeholder={getIdPlaceholder(type)}
            required
          />

          <button
            type="button"
            className="generate-id-button"
            onClick={handleGenerateId}
            disabled={generatingId}
          >
            {generatingId ? '...' : 'Generate'}
          </button>
        </div>

        <label>Nama Node</label>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={getNamePlaceholder(type)}
          required
        />

        <label>Status Awal</label>
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
        <h4 className="form-section-title">Lokasi</h4>

        <div className="location-action-row">
          <button
            type="button"
            className={
              isPickingLocation ? 'pick-location active' : 'pick-location'
            }
            onClick={onTogglePickingLocation}
          >
            {isPickingLocation
              ? 'Mode Klik Peta Aktif'
              : latitude && longitude
                ? 'Ambil Ulang / Geser Titik'
                : 'Ambil Titik dari Peta'}
          </button>

          {(latitude || longitude) && onClearLocation && (
            <button
              type="button"
              className="clear-location-button"
              onClick={onClearLocation}
            >
              Hapus Titik
            </button>
          )}
        </div>

        {isPickingLocation && (
          <p className="pick-info">
            Klik lokasi baru di peta atau geser marker titik sementara.
          </p>
        )}

        {coordinateMessage && <p className="pick-info">{coordinateMessage}</p>}

        <label>Latitude</label>
        <input
          value={latitude}
          onChange={(event) => onLatitudeChange(event.target.value)}
          placeholder="-7.1529"
          required
        />

        <label>Longitude</label>
        <input
          value={longitude}
          onChange={(event) => onLongitudeChange(event.target.value)}
          placeholder="111.8841"
          required
        />
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

          {parentOptions.map((parent) => (
            <option key={parent.id} value={parent.id}>
              {parent.name} ({parent.type})
            </option>
          ))}
        </select>

        {type === 'CLIENT' && (
          <p className="form-helper-text">
            Untuk client, pilih ODP tempat client tersebut terhubung.
          </p>
        )}

        {type === 'ODP' && (
          <p className="form-helper-text">
            Untuk ODP, parent bisa diarahkan ke OLT atau tiang/jalur utama.
          </p>
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
              ODP, OLT, dan tiang sementara menggunakan metode MANUAL. Status
              client tetap dimonitor melalui PPPoE atau PING.
            </span>
          </div>
        )}
      </div>

      <button type="submit" disabled={loading}>
        {loading ? 'Menyimpan...' : 'Simpan Node'}
      </button>

      {message && <p className="form-message">{message}</p>}
    </form>
  )
}
