import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import type { NetworkNode } from "../types/network";
import { getAuthToken } from "../api/auth";

const API_BASE_URL = import.meta.env.VITE_API_URL || window.location.origin

function getAuthorizedJsonHeaders() {
  const token = getAuthToken();

  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

interface AddClientFormProps {
  latitude: string;
  longitude: string;
  coordinateMessage: string;
  isPickingLocation: boolean;
  odpOptions: NetworkNode[];
  currentUserName?: string;
  onLatitudeChange: (value: string) => void;
  onLongitudeChange: (value: string) => void;
  onTogglePickingLocation: () => void;
  onClearLocation?: () => void;
  onSuccess?: (node: NetworkNode) => void;
}

type MonitoringMethod = "MANUAL" | "PING" | "PPPOE" | "OLT" | "SNMP";

interface NetworkDeviceOption {
  id: string;
  name: string;
  type: "MIKROTIK" | "OLT";
  host: string;
  port: number;
  isActive: boolean;
}

export default function AddClientForm({
  latitude,
  longitude,
  coordinateMessage,
  isPickingLocation,
  odpOptions,
  currentUserName = "",
  onLatitudeChange,
  onLongitudeChange,
  onTogglePickingLocation,
  onClearLocation,
  onSuccess,
}: AddClientFormProps) {
  const [id, setId] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerAddress, setCustomerAddress] = useState("");
  const [parentId, setParentId] = useState("");
  const [monitoringMethod, setMonitoringMethod] =
    useState<MonitoringMethod>("PPPOE");
  const [pppoeUsername, setPppoeUsername] = useState("");
  const [onuInterface, setOnuInterface] = useState("");
  const [mikrotikDeviceId, setMikrotikDeviceId] = useState("");
  const [oltDeviceId, setOltDeviceId] = useState("");
  const [networkDevices, setNetworkDevices] = useState<NetworkDeviceOption[]>([]);
  const [deviceMessage, setDeviceMessage] = useState("");

  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [generatingId, setGeneratingId] = useState(false);
  const [message, setMessage] = useState("");

  const sortedOdpOptions = useMemo(
    () =>
      [...odpOptions]
        .filter((node) => node.type === "ODP")
        .sort((a, b) => a.name.localeCompare(b.name)),
    [odpOptions],
  );

  const mikrotikOptions = useMemo(
    () =>
      networkDevices
        .filter((device) => device.type === "MIKROTIK" && device.isActive)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [networkDevices],
  );

  const oltOptions = useMemo(
    () =>
      networkDevices
        .filter((device) => device.type === "OLT" && device.isActive)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [networkDevices],
  );

  useEffect(() => {
    async function fetchNetworkDevices() {
      try {
        setDeviceMessage("");
        const response = await fetch(`${API_BASE_URL}/api/network-devices`, {
          headers: getAuthorizedJsonHeaders(),
        });
        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.message || "Gagal mengambil daftar perangkat monitoring");
        }

        setNetworkDevices(data.devices || []);
      } catch (error) {
        setDeviceMessage(
          error instanceof Error
            ? error.message
            : "Perangkat monitoring belum bisa dimuat.",
        );
      }
    }

    void fetchNetworkDevices();
  }, []);

  async function handleGenerateId() {
    setGeneratingId(true);
    setMessage("");

    try {
      const response = await fetch(
        `${API_BASE_URL}/api/nodes/generate-id/CLIENT`,
      );
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || "Gagal membuat ID client otomatis");
      }

      setId(data.id);
      setMessage(`ID client otomatis: ${data.id}`);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Terjadi kesalahan saat membuat ID client.",
      );
    } finally {
      setGeneratingId(false);
    }
  }

  async function handleSyncPppoeAndOlt() {
    if (!pppoeUsername.trim()) {
      setMessage("Masukkan Username PPPoE terlebih dahulu.");
      return;
    }

    setSyncing(true);
    setMessage("Menyinkronkan data PPPoE MikroTik & OLT...");

    try {
      const response = await fetch(`${API_BASE_URL}/api/client/sync-pppoe`, {
        method: "POST",
        headers: getAuthorizedJsonHeaders(),
        body: JSON.stringify({
          pppoeUsername: pppoeUsername.trim(),
          mikrotikDeviceId: mikrotikDeviceId || undefined,
          oltDeviceId: oltDeviceId || undefined,
        }),
      });

      const resData = await response.json();
      if (!response.ok) throw new Error(resData.message || "Gagal sinkronisasi data");

      const d = resData.data;
      if (d.onuInterface) setOnuInterface(d.onuInterface);
      if (d.mikrotikDeviceId && !mikrotikDeviceId) setMikrotikDeviceId(d.mikrotikDeviceId);

      const rxText = d.rxPower !== null ? `${d.rxPower} dBm` : "-";
      const ipText = d.ipAddress ? `IP: ${d.ipAddress}` : "IP belum didapat";
      setMessage(`Sinkron Berhasil! Status: ${d.status} | ${ipText} | Redaman: ${rxText}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Terjadi kesalahan sinkronisasi.");
    } finally {
      setSyncing(false);
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setMessage("");

    try {
      const cleanId = id.trim();
      const cleanName = customerName.trim();
      const cleanPppoeUsername = pppoeUsername.trim();
      const cleanOnuInterface = onuInterface.trim();

      if (!cleanId) throw new Error("ID client wajib diisi atau klik Generate.");
      if (!cleanName) throw new Error("Nama pelanggan wajib diisi.");
      if (!parentId) throw new Error("Pilih ODP terlebih dahulu.");
      if (!latitude || !longitude) throw new Error("Koordinat client wajib diisi.");

      const response = await fetch(`${API_BASE_URL}/api/nodes`, {
        method: "POST",
        headers: getAuthorizedJsonHeaders(),
        body: JSON.stringify({
          id: cleanId,
          name: cleanName,
          type: "CLIENT",
          ipAddress: null,
          latitude: Number(latitude),
          longitude: Number(longitude),
          status: "UNKNOWN",
          rxPower: null,
          parentId,
          pppoeUsername: cleanPppoeUsername || null,
          monitoringEnabled: monitoringMethod !== "MANUAL",
          monitoringMethod,
          mikrotikDeviceId: mikrotikDeviceId || null,
          oltDeviceId: oltDeviceId || null,
          onuInterface: cleanOnuInterface || null,
          onuStatus: cleanOnuInterface ? "UNKNOWN" : null,
          onuRxPower: null,
          customerName: cleanName,
          customerPhone: customerPhone.trim() || null,
          customerAddress: customerAddress.trim() || null,
          installationStatus: "ACTIVE",
          salesName: currentUserName || null,
        }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Gagal menambahkan client");

      setMessage("Client berhasil ditambahkan.");
      setId("");
      setCustomerName("");
      setCustomerPhone("");
      setCustomerAddress("");
      setParentId("");
      setPppoeUsername("");
      setOnuInterface("");
      setMikrotikDeviceId("");
      setOltDeviceId("");
      onLatitudeChange("");
      onLongitudeChange("");

      if (onSuccess) onSuccess(data.node);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Terjadi kesalahan.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="add-node-form add-client-form" onSubmit={handleSubmit}>
      <div className="form-header-row">
        <h3>Tambah Client</h3>
      </div>

      <label>ID Client</label>
      <div className="id-row">
        <input
          value={id}
          onChange={(event) => setId(event.target.value)}
          placeholder="client-0001"
          required
        />
        <button
          type="button"
          className="generate-id-button"
          onClick={handleGenerateId}
          disabled={generatingId}
        >
          {generatingId ? "..." : "Generate"}
        </button>
      </div>

      <label>Nama Client</label>
      <input
        value={customerName}
        onChange={(event) => setCustomerName(event.target.value)}
        placeholder="Nama pelanggan"
        required
      />

      <label>No WhatsApp / Telepon</label>
      <input
        value={customerPhone}
        onChange={(event) => setCustomerPhone(event.target.value)}
        placeholder="Contoh: 081234567890"
      />

      <label>Alamat</label>
      <textarea
        value={customerAddress}
        onChange={(event) => setCustomerAddress(event.target.value)}
        placeholder="Alamat lengkap pelanggan"
        rows={3}
      />

      <label>Pilih ODP</label>
      <select
        value={parentId}
        onChange={(event) => setParentId(event.target.value)}
        required
      >
        <option value="">-- Pilih ODP --</option>
        {sortedOdpOptions.map((odp) => (
          <option key={odp.id} value={odp.id}>
            {odp.name} ({odp.id})
          </option>
        ))}
      </select>

      <label>Metode Monitoring</label>
      <select
        value={monitoringMethod}
        onChange={(event) =>
          setMonitoringMethod(event.target.value as MonitoringMethod)
        }
      >
        <option value="PPPOE">PPPoE MikroTik (Auto-Detect OLT)</option>
        <option value="OLT">OLT ZTE C320 / ONU</option>
        <option value="PING">PING IP</option>
        <option value="MANUAL">Manual</option>
      </select>

      {deviceMessage && <p className="form-message form-message-error">{deviceMessage}</p>}

      <label>Pilih MikroTik</label>
      <select
        value={mikrotikDeviceId}
        onChange={(event) => setMikrotikDeviceId(event.target.value)}
      >
        <option value="">-- Pilih MikroTik Gateway --</option>
        {mikrotikOptions.map((device) => (
          <option key={device.id} value={device.id}>
            {device.name} ({device.host}:{device.port})
          </option>
        ))}
      </select>

      <label>Pilih OLT</label>
      <select
        value={oltDeviceId}
        onChange={(event) => setOltDeviceId(event.target.value)}
      >
        <option value="">-- Pilih OLT Gateway --</option>
        {oltOptions.map((device) => (
          <option key={device.id} value={device.id}>
            {device.name} ({device.host}:{device.port})
          </option>
        ))}
      </select>

      <label>Username PPPoE (Format Port PON)</label>
      <div style={{ display: 'flex', gap: '8px' }}>
        <input
          value={pppoeUsername}
          onChange={(event) => setPppoeUsername(event.target.value)}
          placeholder="Contoh: 1/2/3:11_bala_desa_balen"
          style={{ flex: 1 }}
        />
        <button
          type="button"
          className="submit-node-button"
          style={{ width: 'auto', padding: '0 14px', margin: 0, whiteSpace: 'nowrap' }}
          onClick={handleSyncPppoeAndOlt}
          disabled={syncing}
        >
          {syncing ? 'Sync...' : 'Sync OLT & PPPoE'}
        </button>
      </div>

      <label style={{ marginTop: '10px' }}>ONU Interface</label>
      <input
        value={onuInterface}
        onChange={(event) => setOnuInterface(event.target.value)}
        placeholder="Contoh: gpon-onu_1/2/3:11"
      />

      <label>Latitude</label>
      <input
        value={latitude}
        onChange={(event) => onLatitudeChange(event.target.value)}
        placeholder="-7.xxxxxx"
        required
      />

      <label>Longitude</label>
      <input
        value={longitude}
        onChange={(event) => onLongitudeChange(event.target.value)}
        placeholder="111.xxxxxx"
        required
      />

      <div className="location-action-row">
        <button
          type="button"
          className={isPickingLocation ? "pick-location active" : "pick-location"}
          onClick={onTogglePickingLocation}
        >
          {isPickingLocation
            ? "Klik titik di peta..."
            : latitude && longitude
              ? "Ambil Ulang / Geser Titik"
              : "Ambil Titik dari Peta"}
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

      {coordinateMessage && <p className="pick-info">{coordinateMessage}</p>}
      {message && <p className="form-message">{message}</p>}

      <button type="submit" disabled={loading}>
        {loading ? "Menyimpan..." : "Simpan Client"}
      </button>
    </form>
  );
}