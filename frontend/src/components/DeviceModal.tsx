import React, { useState } from 'react';

export interface Device {
  id: number;
  name: string;
  type: 'MIKROTIK' | 'OLT_ZTE' | 'OLT';
  host: string;
  port: number;
  username?: string;
  brand?: string | null;
  model?: string | null;
  connectionStatus?: string;
  notes?: string | null;
  isActive?: boolean;
}

interface DeviceModalProps {
  isOpen: boolean;
  onClose: () => void;
  devices: Device[];
  onRefresh: () => void;
  onTestDevice: (id: number) => Promise<void>;
  onDeleteDevice: (id: number) => Promise<void>;
  onSaveDevice: (data: {
    id?: number;
    name: string;
    type: string;
    host: string;
    port: number;
    username?: string;
    password?: string;
    brand?: string;
    model?: string;
    notes?: string;
    isActive?: boolean;
  }) => Promise<void>;
}

export const DeviceModal: React.FC<DeviceModalProps> = ({
  isOpen,
  onClose,
  devices,
  onRefresh,
  onTestDevice,
  onDeleteDevice,
  onSaveDevice,
}) => {
  const [editingId, setEditingId] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [type, setType] = useState<'OLT' | 'MIKROTIK'>('OLT');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('161');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [brand, setBrand] = useState('ZTE');
  const [model, setModel] = useState('C320');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [testingId, setTestingId] = useState<number | null>(null);

  // State untuk Notifikasi Kustom (Pengganti alert())
  const [notification, setNotification] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  if (!isOpen) return null;

  const showToast = (message: string, type: 'success' | 'error') => {
    setNotification({ message, type });
    setTimeout(() => setNotification(null), 4000); // Hilang otomatis dalam 4 detik
  };

  const handleTypeChange = (nextType: 'OLT' | 'MIKROTIK') => {
    setType(nextType);
    setPort(nextType === 'OLT' ? '161' : '8728');
    if (nextType === 'MIKROTIK') {
      setUsername('admin');
      setBrand('MikroTik');
      setModel('RouterOS');
    } else {
      setUsername('snmp');
      setBrand('ZTE');
      setModel('C320');
    }
  };

  const handleStartEdit = (d: Device) => {
    setEditingId(d.id);
    setName(d.name);
    const normalizedType = d.type.includes('OLT') ? 'OLT' : 'MIKROTIK';
    setType(normalizedType);
    setHost(d.host);
    setPort(String(d.port));
    setUsername(d.username || (normalizedType === 'OLT' ? 'snmp' : 'admin'));
    setPassword('');
    setBrand(d.brand || (normalizedType === 'OLT' ? 'ZTE' : 'MikroTik'));
    setModel(d.model || (normalizedType === 'OLT' ? 'C320' : 'RouterOS'));
    setNotes(d.notes || '');
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setName('');
    setType('OLT');
    setHost('');
    setPort('161');
    setUsername('');
    setPassword('');
    setBrand('ZTE');
    setModel('C320');
    setNotes('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await onSaveDevice({
        id: editingId !== null ? editingId : undefined,
        name: name.trim(),
        type,
        host: host.trim(),
        port: Number(port),
        username: username.trim(),
        password: password.trim() || undefined,
        brand: brand.trim(),
        model: model.trim(),
        notes: notes.trim(),
      });
      showToast(editingId !== null ? 'Perubahan perangkat berhasil disimpan.' : 'Perangkat baru berhasil ditambahkan.', 'success');
      handleCancelEdit();
    } catch (err: unknown) {
      const errMessage = err instanceof Error ? err.message : String(err);
      showToast(errMessage || 'Gagal menyimpan perangkat.', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleTest = async (id: number) => {
    setTestingId(id);
    try {
      await onTestDevice(id);
      showToast('Test koneksi perangkat berhasil.', 'success');
    } catch (err: unknown) {
      const errMessage = err instanceof Error ? err.message : String(err);
      showToast(errMessage || 'Gagal terhubung ke perangkat.', 'error');
    } finally {
      setTestingId(null);
    }
  };

  const handleDelete = async (id: number) => {
    const confirmed = window.confirm('Yakin ingin menghapus perangkat monitoring ini?');
    if (!confirmed) return;

    try {
      await onDeleteDevice(id);
      showToast('Perangkat berhasil dihapus.', 'success');
    } catch (err: unknown) {
      const errMessage = err instanceof Error ? err.message : String(err);
      showToast(errMessage || 'Gagal menghapus perangkat.', 'error');
    }
  };

  return (
    <div className="app-modal-backdrop">
      <div className="app-modal app-modal-form" style={{ maxWidth: '900px', width: '95%' }}>
        {/* Header Modal */}
        <div className="app-modal-header">
          <div>
            <h2>Device Management</h2>
            <p>Kelola gateway OLT (SNMP) dan MikroTik Router secara terpusat.</p>
          </div>
          <button type="button" className="app-modal-close" onClick={onClose}>
            ×
          </button>
        </div>

        <div style={{ padding: '20px', maxHeight: '75vh', overflowY: 'auto', position: 'relative' }}>
          
          {/* Custom Toast Notification */}
          {notification && (
            <div style={{
              padding: '12px 16px',
              borderRadius: '8px',
              marginBottom: '16px',
              fontSize: '13px',
              fontWeight: 500,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              background: notification.type === 'success' ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)',
              border: `1px solid ${notification.type === 'success' ? '#10b981' : '#ef4444'}`,
              color: notification.type === 'success' ? '#34d399' : '#f87171'
            }}>
              <span>{notification.message}</span>
              <button 
                onClick={() => setNotification(null)}
                style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: '16px', fontWeight: 'bold' }}
              >
                ×
              </button>
            </div>
          )}

          {/* SECTION: FORM TAMBAH / EDIT PERANGKAT */}
          <div style={{ background: 'rgba(15, 23, 42, 0.6)', border: '1px solid #334155', borderRadius: '12px', padding: '16px', marginBottom: '24px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <h3 style={{ color: '#fff', fontSize: '14px', margin: 0 }}>
                {editingId !== null ? `Edit Perangkat: ${name}` : '+ Tambah Gateway Baru'}
              </h3>
              {editingId !== null && (
                <button
                  type="button"
                  onClick={handleCancelEdit}
                  style={{ background: 'transparent', border: 'none', color: '#94a3b8', fontSize: '12px', cursor: 'pointer' }}
                >
                  Batal Edit
                </button>
              )}
            </div>

            <form className="device-form" onSubmit={handleSubmit} style={{ margin: 0 }}>
              <label>Jenis Perangkat</label>
              <select
                value={type}
                onChange={(e) => handleTypeChange(e.target.value as 'OLT' | 'MIKROTIK')}
              >
                <option value="OLT">OLT ZTE (SNMP v2c)</option>
                <option value="MIKROTIK">MikroTik (RouterOS API)</option>
              </select>

              <label>Nama Perangkat</label>
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={type === 'OLT' ? 'Contoh: OLT ZTE Balen' : 'Contoh: MikroTik Gateway'}
              />

              <div className="device-form-row">
                <label>
                  Host / IP Address
                  <input
                    required
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    placeholder="136.2.2.200"
                  />
                </label>
                <label>
                  Port
                  <input
                    required
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                    placeholder={type === 'OLT' ? '161' : '8728'}
                    inputMode="numeric"
                  />
                </label>
              </div>

              {type === 'MIKROTIK' && (
                <>
                  <label>Username API</label>
                  <input
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="admin"
                  />
                </>
              )}

              <label>
                {type === 'OLT' ? 'SNMP Community (Read-Only)' : 'Password API'}
                {editingId !== null && <span style={{ color: '#94a3b8', fontWeight: 'normal' }}> (Kosongkan jika tidak diubah)</span>}
              </label>
              <input
                required={editingId === null}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={type === 'OLT' ? 'Contoh: public' : 'Password Router'}
              />

              <div className="device-form-row" style={{ marginTop: '10px' }}>
                <label>
                  Brand
                  <input
                    value={brand}
                    onChange={(e) => setBrand(e.target.value)}
                    placeholder="ZTE / MikroTik"
                  />
                </label>
                <label>
                  Model
                  <input
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder="C320 / RouterOS"
                  />
                </label>
              </div>

              <button type="submit" disabled={submitting} style={{ marginTop: '14px', background: editingId !== null ? '#0284c7' : '#2563eb' }}>
                {submitting ? 'Menyimpan...' : editingId !== null ? 'Simpan Perubahan' : 'Simpan Perangkat'}
              </button>
            </form>
          </div>

          {/* SECTION: DAFTAR PERANGKAT */}
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <h3 style={{ color: '#fff', fontSize: '14px', margin: 0 }}>Daftar Gateway ({devices.length})</h3>
              <button
                type="button"
                onClick={onRefresh}
                style={{ padding: '6px 12px', fontSize: '12px', background: '#334155', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer' }}
              >
                Refresh Data
              </button>
            </div>

            <div style={{ border: '1px solid #334155', borderRadius: '8px', overflow: 'hidden', background: '#020617' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
                <thead>
                  <tr style={{ background: '#0f172a', color: '#94a3b8', borderBottom: '1px solid #334155', fontSize: '11px', textTransform: 'uppercase' }}>
                    <th style={{ padding: '12px' }}>Nama</th>
                    <th style={{ padding: '12px' }}>Tipe</th>
                    <th style={{ padding: '12px' }}>IP & Port</th>
                    <th style={{ padding: '12px' }}>Status</th>
                    <th style={{ padding: '12px', textAlign: 'right' }}>Aksi</th>
                  </tr>
                </thead>
                <tbody>
                  {devices.length === 0 ? (
                    <tr>
                      <td colSpan={5} style={{ padding: '24px', textAlign: 'center', color: '#64748b' }}>
                        Belum ada perangkat terdaftar.
                      </td>
                    </tr>
                  ) : (
                    devices.map((d) => (
                      <tr key={d.id} style={{ borderBottom: '1px solid #1e293b' }}>
                        <td style={{ padding: '12px', color: '#fff', fontWeight: 600 }}>{d.name}</td>
                        <td style={{ padding: '12px', color: '#cbd5e1' }}>{d.brand || d.type}</td>
                        <td style={{ padding: '12px', fontFamily: 'monospace', color: '#38bdf8' }}>{d.host}:{d.port}</td>
                        <td style={{ padding: '12px' }}>
                          <span style={{ fontSize: '11px', padding: '3px 8px', borderRadius: '4px', fontWeight: 500, background: d.connectionStatus === 'CONNECTED' ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)', color: d.connectionStatus === 'CONNECTED' ? '#34d399' : '#f87171' }}>
                            {d.connectionStatus === 'CONNECTED' ? 'Terhubung' : 'Terputus'}
                          </span>
                        </td>
                        <td style={{ padding: '12px', textAlign: 'right' }}>
                          <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
                            <button
                              type="button"
                              onClick={() => handleStartEdit(d)}
                              style={{ padding: '5px 10px', background: '#0284c7', color: '#fff', border: 'none', borderRadius: '4px', fontSize: '11px', cursor: 'pointer', fontWeight: 500 }}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              disabled={testingId === Number(d.id)}
                              onClick={() => handleTest(Number(d.id))}
                              style={{ padding: '5px 10px', background: '#059669', color: '#fff', border: 'none', borderRadius: '4px', fontSize: '11px', cursor: 'pointer', fontWeight: 500 }}
                            >
                              {testingId === Number(d.id) ? '...' : 'Test'}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDelete(Number(d.id))}
                              style={{ padding: '5px 10px', background: '#dc2626', color: '#fff', border: 'none', borderRadius: '4px', fontSize: '11px', cursor: 'pointer', fontWeight: 500 }}
                            >
                              Hapus
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
};