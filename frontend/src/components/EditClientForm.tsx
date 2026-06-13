import { useMemo, useState } from 'react'
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
}

type MonitoringMethod = 'MANUAL' | 'PING' | 'PPPOE' | 'OLT' | 'SNMP'

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

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setLoading(true)
    setMessage('')

    try {
      if (!customerName.trim()) {
        throw new Error('Nama client wajib diisi.')
      }

      if (!parentId) {
        throw new Error('Pilih ODP terlebih dahulu.')
      }

      if (monitoringMethod === 'PPPOE' && !pppoeUsername.trim()) {
        throw new Error('Username PPPoE wajib diisi jika monitoring memakai PPPoE.')
      }

      if (monitoringMethod === 'OLT' && !onuInterface.trim()) {
        throw new Error('ONU Interface wajib diisi jika monitoring memakai OLT.')
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
          name: customerName.trim(),
          type: 'CLIENT',
          ipAddress: node.ipAddress || null,
          latitude: finalLatitude,
          longitude: finalLongitude,
          status: node.status,
          rxPower: node.rxPower ?? null,
          parentId,
          pppoeUsername: pppoeUsername.trim() || null,
          monitoringEnabled: monitoringMethod !== 'MANUAL',
          monitoringMethod,
          onuInterface: onuInterface.trim() || null,
          onuStatus: onuInterface.trim() ? extraNode.onuStatus || 'UNKNOWN' : null,

          customerName: customerName.trim(),
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
      if (!onuInterface.trim()) {
        throw new Error('ONU Interface wajib diisi sebelum cek OLT.')
      }

      const response = await fetch(`${API_BASE_URL}/api/olt/check-onu`, {
        method: 'POST',
        headers: getAuthorizedJsonHeaders(),
        body: JSON.stringify({
          nodeId: node.id,
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
          onChange={(event) => setMonitoringMethod(event.target.value as MonitoringMethod)}
        >
          <option value="PPPOE">PPPoE MikroTik</option>
          <option value="OLT">OLT ZTE C320 / ONU</option>
          <option value="PING">PING IP</option>
          <option value="MANUAL">Manual</option>
        </select>

        <label>Username PPPoE</label>
        <input
          value={pppoeUsername}
          onChange={(event) => setPppoeUsername(event.target.value)}
          placeholder="Contoh: 1/2/3:11_budi"
          required={monitoringMethod === 'PPPOE'}
        />

        {monitoringMethod === 'OLT' && (
          <>
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
