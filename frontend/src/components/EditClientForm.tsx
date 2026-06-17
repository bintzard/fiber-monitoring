import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
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

type ClientExtraFields = NetworkNode & {
  customerName?: string | null
  customerPhone?: string | null
  customerAddress?: string | null
  onuInterface?: string | null
  onuStatus?: string | null
  onuRxPower?: number | null
  mikrotikDeviceId?: string | null
  oltDeviceId?: string | null
}

type MonitoringMethod = 'MANUAL' | 'PING' | 'PPPOE' | 'OLT' | 'SNMP'

interface NetworkDeviceOption {
  id: string
  name: string
  type: 'MIKROTIK' | 'OLT'
  host: string
  port: number
  isActive: boolean
}

interface EditClientFormProps {
  node: NetworkNode
  odpOptions: NetworkNode[]
  onClose: () => void
  onSuccess?: (node: NetworkNode) => void
}

function getClientExtra(node: NetworkNode) {
  return node as ClientExtraFields
}

export default function EditClientForm({
  node,
  odpOptions,
  onClose,
  onSuccess,
}: EditClientFormProps) {
  const extraNode = getClientExtra(node)

  const [customerName, setCustomerName] = useState(
    extraNode.customerName || node.name || '',
  )
  const [customerPhone, setCustomerPhone] = useState(extraNode.customerPhone || '')
  const [customerAddress, setCustomerAddress] = useState(
    extraNode.customerAddress || '',
  )
  const [parentId, setParentId] = useState(node.parentId || '')
  const [pppoeUsername, setPppoeUsername] = useState(node.pppoeUsername || '')
  const [monitoringMethod, setMonitoringMethod] = useState<MonitoringMethod>(
    (node.monitoringMethod as MonitoringMethod) || 'PPPOE',
  )
  const [onuInterface, setOnuInterface] = useState(extraNode.onuInterface || '')
  const [mikrotikDeviceId, setMikrotikDeviceId] = useState(
    extraNode.mikrotikDeviceId || '',
  )
  const [oltDeviceId, setOltDeviceId] = useState(extraNode.oltDeviceId || '')
  const [networkDevices, setNetworkDevices] = useState<NetworkDeviceOption[]>([])
  const [deviceMessage, setDeviceMessage] = useState('')
  const [latitude, setLatitude] = useState(String(node.latitude))
  const [longitude, setLongitude] = useState(String(node.longitude))

  const [loading, setLoading] = useState(false)
  const [checkingOlt, setCheckingOlt] = useState(false)
  const [message, setMessage] = useState('')

  const sortedOdpOptions = useMemo(
    () =>
      [...odpOptions]
        .filter((item) => item.type === 'ODP')
        .sort((a, b) => a.name.localeCompare(b.name)),
    [odpOptions],
  )

  const mikrotikOptions = useMemo(
    () =>
      networkDevices
        .filter((device) => device.type === 'MIKROTIK' && device.isActive)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [networkDevices],
  )

  const oltOptions = useMemo(
    () =>
      networkDevices
        .filter((device) => device.type === 'OLT' && device.isActive)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [networkDevices],
  )

  useEffect(() => {
    let isMounted = true

    async function fetchNetworkDevices() {
      try {
        const response = await fetch(`${API_BASE_URL}/api/network-devices`, {
          headers: getAuthorizedJsonHeaders(),
        })
        const data = await response.json()

        if (!response.ok) {
          throw new Error(data.message || 'Gagal mengambil daftar perangkat monitoring')
        }

        if (isMounted) {
          setNetworkDevices(data.devices || [])
          setDeviceMessage('')
        }
      } catch (error) {
        if (isMounted) {
          setDeviceMessage(
            error instanceof Error
              ? error.message
              : 'Perangkat monitoring belum bisa dimuat.',
          )
        }
      }
    }

    void fetchNetworkDevices()

    return () => {
      isMounted = false
    }
  }, [])

  function handleMonitoringMethodChange(nextMethod: MonitoringMethod) {
    setMonitoringMethod(nextMethod)

    if (nextMethod !== 'PPPOE') {
      setMikrotikDeviceId('')
    }

    if (nextMethod !== 'OLT') {
      setOltDeviceId('')
      setOnuInterface('')
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setLoading(true)
    setMessage('')

    try {
      const cleanCustomerName = customerName.trim()
      const cleanPppoeUsername = pppoeUsername.trim()
      const cleanOnuInterface = onuInterface.trim()

      if (!cleanCustomerName) {
        throw new Error('Nama client wajib diisi.')
      }

      if (!parentId) {
        throw new Error('Pilih ODP terlebih dahulu.')
      }

      if (monitoringMethod === 'PPPOE' && !cleanPppoeUsername) {
        throw new Error('Username PPPoE wajib diisi jika monitoring memakai PPPoE.')
      }

      if (monitoringMethod === 'PPPOE' && !mikrotikDeviceId) {
        throw new Error('Pilih MikroTik untuk monitoring PPPoE.')
      }

      if (monitoringMethod === 'OLT' && !cleanOnuInterface) {
        throw new Error('ONU Interface wajib diisi jika monitoring memakai OLT.')
      }

      if (monitoringMethod === 'OLT' && !oltDeviceId) {
        throw new Error('Pilih OLT untuk monitoring ONU.')
      }

      if (!latitude || !longitude) {
        throw new Error('Latitude dan longitude wajib diisi.')
      }

      const finalLatitude = Number(latitude)
      const finalLongitude = Number(longitude)

      if (Number.isNaN(finalLatitude) || Number.isNaN(finalLongitude)) {
        throw new Error('Latitude dan longitude harus berupa angka.')
      }

      const response = await fetch(`${API_BASE_URL}/api/nodes/${node.id}`, {
        method: 'PATCH',
        headers: getAuthorizedJsonHeaders(),
        body: JSON.stringify({
          name: cleanCustomerName,
          type: 'CLIENT',
          ipAddress: node.ipAddress || null,
          latitude: finalLatitude,
          longitude: finalLongitude,
          status: node.status,
          rxPower: node.rxPower ?? null,
          parentId,

          pppoeUsername: monitoringMethod === 'PPPOE' ? cleanPppoeUsername : null,
          monitoringEnabled: monitoringMethod !== 'MANUAL',
          monitoringMethod,
          mikrotikDeviceId:
            monitoringMethod === 'PPPOE' ? mikrotikDeviceId || null : null,
          oltDeviceId: monitoringMethod === 'OLT' ? oltDeviceId || null : null,
          onuInterface: monitoringMethod === 'OLT' ? cleanOnuInterface || null : null,
          onuStatus:
            monitoringMethod === 'OLT' && cleanOnuInterface
              ? extraNode.onuStatus || 'UNKNOWN'
              : null,

          customerName: cleanCustomerName,
          customerPhone: customerPhone.trim() || null,
          customerAddress: customerAddress.trim() || null,
          installationStatus: 'ACTIVE',
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.message || 'Gagal memperbarui client')
      }

      setMessage('Data client berhasil diperbarui.')

      if (onSuccess) {
        onSuccess(data.node)
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Terjadi kesalahan.')
    } finally {
      setLoading(false)
    }
  }

  async function handleCheckOlt() {
    setCheckingOlt(true)
    setMessage('')

    try {
      if (!oltDeviceId) {
        throw new Error('Pilih OLT terlebih dahulu sebelum cek ONU.')
      }

      if (!onuInterface.trim()) {
        throw new Error('ONU Interface wajib diisi sebelum cek OLT.')
      }

      const response = await fetch(`${API_BASE_URL}/api/olt/check-onu`, {
        method: 'POST',
        headers: getAuthorizedJsonHeaders(),
        body: JSON.stringify({
          nodeId: node.id,
          oltDeviceId,
          onuInterface: onuInterface.trim(),
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.message || 'Gagal cek ONU dari OLT.')
      }

      const resultText = `${data.result?.mappedNodeStatus || '-'} / ${data.result?.onuStatus || '-'} / RX ${data.result?.onuRxPower ?? '-'} dBm`
      setMessage(`Cek OLT berhasil: ${resultText}`)

      if (data.updatedNode && onSuccess) {
        onSuccess(data.updatedNode)
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Terjadi kesalahan saat cek OLT.')
    } finally {
      setCheckingOlt(false)
    }
  }

  return (
    <form className="edit-node-form edit-client-form" onSubmit={handleSubmit}>
      <div className="form-header-row">
        <h3>Edit Client</h3>

        <button type="button" className="close-form-button" onClick={onClose}>
          Tutup
        </button>
      </div>

      <p className="node-id-info">ID: {node.id}</p>

      <div className="form-section">
        <h4 className="form-section-title">Data Client</h4>

        <label>Nama Client</label>
        <input
          value={customerName}
          onChange={(event) => setCustomerName(event.target.value)}
          placeholder="Contoh: Budi Santoso"
          required
        />

        <label>No WhatsApp / Telepon</label>
        <input
          value={customerPhone}
          onChange={(event) => setCustomerPhone(event.target.value)}
          placeholder="08xxxxxxxxxx"
        />

        <label>Alamat</label>
        <textarea
          value={customerAddress}
          onChange={(event) => setCustomerAddress(event.target.value)}
          placeholder="Alamat lengkap client"
          rows={3}
        />
      </div>

      <div className="form-section">
        <h4 className="form-section-title">ODP & Monitoring</h4>

        <label>ODP</label>
        <select
          value={parentId}
          onChange={(event) => setParentId(event.target.value)}
          required
        >
          <option value="">Pilih ODP</option>
          {sortedOdpOptions.map((odp) => (
            <option key={odp.id} value={odp.id}>
              {odp.name}
            </option>
          ))}
        </select>

        <label>Metode Monitoring</label>
        <select
          value={monitoringMethod}
          onChange={(event) =>
            handleMonitoringMethodChange(event.target.value as MonitoringMethod)
          }
        >
          <option value="PPPOE">PPPoE MikroTik</option>
          <option value="OLT">OLT ZTE C320 / ONU</option>
          <option value="PING">PING IP</option>
          <option value="MANUAL">Manual</option>
        </select>

        {deviceMessage && (
          <p className="form-message form-message-error">{deviceMessage}</p>
        )}

        {monitoringMethod === 'PPPOE' && (
          <>
            <label>Pilih MikroTik</label>
            <select
              value={mikrotikDeviceId}
              onChange={(event) => setMikrotikDeviceId(event.target.value)}
              required
            >
              <option value="">
                {mikrotikOptions.length > 0
                  ? '-- Pilih MikroTik --'
                  : 'Belum ada MikroTik aktif'}
              </option>
              {mikrotikOptions.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.name} ({device.host}:{device.port})
                </option>
              ))}
            </select>

            <label>Username PPPoE</label>
            <input
              value={pppoeUsername}
              onChange={(event) => setPppoeUsername(event.target.value)}
              placeholder="Contoh: 1/2/3:11_budi"
              required
            />
          </>
        )}

        {monitoringMethod === 'OLT' && (
          <>
            <label>Pilih OLT</label>
            <select
              value={oltDeviceId}
              onChange={(event) => setOltDeviceId(event.target.value)}
              required
            >
              <option value="">
                {oltOptions.length > 0 ? '-- Pilih OLT --' : 'Belum ada OLT aktif'}
              </option>
              {oltOptions.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.name} ({device.host}:{device.port})
                </option>
              ))}
            </select>

            <label>ONU Interface OLT</label>
            <input
              value={onuInterface}
              onChange={(event) => setOnuInterface(event.target.value)}
              placeholder="Contoh: gpon-onu_1/2/3:2"
              required
            />

            <button
              type="button"
              className="submit-node-button"
              onClick={handleCheckOlt}
              disabled={checkingOlt}
            >
              {checkingOlt ? 'Mengecek OLT...' : 'Cek ONU dari OLT'}
            </button>

            <small className="form-helper-text">
              Tombol ini akan mengecek status ONU langsung ke OLT dan memperbarui status client.
            </small>
          </>
        )}
      </div>

      <div className="form-section">
        <h4 className="form-section-title">Koordinat</h4>

        <label>Latitude</label>
        <input
          value={latitude}
          onChange={(event) => setLatitude(event.target.value)}
          placeholder="-7.xxxxxx"
          required
        />

        <label>Longitude</label>
        <input
          value={longitude}
          onChange={(event) => setLongitude(event.target.value)}
          placeholder="111.xxxxxx"
          required
        />

        <small>
          Koordinat juga bisa diubah lebih cepat dengan tombol Edit Lokasi di map.
        </small>
      </div>

      {message && <p className="form-message">{message}</p>}

      <button type="submit" className="submit-node-button" disabled={loading}>
        {loading ? 'Menyimpan...' : 'Simpan Perubahan Client'}
      </button>
    </form>
  )
}
