import React, { useState } from 'react';

export interface Device {
  id: number;
  name: string;
  type: 'MIKROTIK' | 'OLT_ZTE' | 'OLT';
  host: string;
  port: number;
  username?: string;
  lastCheckStatus?: string;
  lastCheckMessage?: string;
  lastCheckAt?: string;
}

interface DeviceModalProps {
  isOpen: boolean;
  onClose: () => void;
  devices: Device[];
  onRefresh: () => void;
  onTestDevice: (id: number) => Promise<void>;
  onDeleteDevice: (id: number) => Promise<void>;
  onSaveDevice: (data: {
    name: string;
    type: string;
    host: string;
    port: number;
    username?: string;
    password?: string;
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
  const [name, setName] = useState('');
  const [type, setType] = useState<'OLT_ZTE' | 'MIKROTIK'>('OLT_ZTE');
  const [host, setHost] = useState('');
  const [port, setPort] = useState<number>(161);
  const [username, setUsername] = useState('');
  const [communityOrPass, setCommunityOrPass] = useState('');
  const [testingId, setTestingId] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!isOpen) return null;

  const handleTypeChange = (selectedType: 'OLT_ZTE' | 'MIKROTIK') => {
    setType(selectedType);
    setPort(selectedType === 'OLT_ZTE' ? 161 : 8728);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await onSaveDevice({
        name,
        type,
        host,
        port: Number(port),
        username: type === 'MIKROTIK' ? username : undefined,
        password: communityOrPass,
      });
      // Reset Form
      setName('');
      setHost('');
      setUsername('');
      setCommunityOrPass('');
    } finally {
      setSubmitting(false);
    }
  };

  const handleTest = async (id: number) => {
    setTestingId(id);
    try {
      await onTestDevice(id);
    } finally {
      setTestingId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-4xl max-h-[90vh] overflow-y-auto rounded-2xl bg-[#0f172a] border border-slate-700 p-6 text-slate-100 shadow-2xl">
        {/* Header Modal */}
        <div className="flex items-center justify-between pb-4 border-b border-slate-800">
          <div>
            <h2 className="text-xl font-bold text-white">Device Management</h2>
            <p className="text-xs text-slate-400">Kelola gateway OLT (SNMP) dan MikroTik Router</p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white flex items-center justify-center font-bold"
          >
            ✕
          </button>
        </div>

        {/* Form Tambah Device */}
        <form onSubmit={handleSubmit} className="mt-4 p-4 rounded-xl bg-slate-900/90 border border-slate-800 grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
          <div>
            <label className="text-slate-400 font-medium">Nama Perangkat</label>
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Contoh: OLT-Balen"
              className="w-full mt-1 px-3 py-2 bg-slate-950 border border-slate-700 rounded-lg focus:border-blue-500 outline-none text-white"
            />
          </div>

          <div>
            <label className="text-slate-400 font-medium">Tipe Perangkat</label>
            <select
              value={type}
              onChange={(e) => handleTypeChange(e.target.value as 'OLT_ZTE' | 'MIKROTIK')}
              className="w-full mt-1 px-3 py-2 bg-slate-950 border border-slate-700 rounded-lg outline-none text-white"
            >
              <option value="OLT_ZTE">OLT ZTE (SNMP v2c)</option>
              <option value="MIKROTIK">MikroTik (RouterOS API)</option>
            </select>
          </div>

          <div>
            <label className="text-slate-400 font-medium">Host / IP Address</label>
            <input
              required
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="136.2.2.200"
              className="w-full mt-1 px-3 py-2 bg-slate-950 border border-slate-700 rounded-lg outline-none text-white"
            />
          </div>

          <div>
            <label className="text-slate-400 font-medium">Port</label>
            <input
              type="number"
              required
              value={port}
              onChange={(e) => setPort(Number(e.target.value))}
              className="w-full mt-1 px-3 py-2 bg-slate-950 border border-slate-700 rounded-lg outline-none text-white"
            />
          </div>

          {type === 'MIKROTIK' ? (
            <div>
              <label className="text-slate-400 font-medium">User API</label>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="User MikroTik"
                className="w-full mt-1 px-3 py-2 bg-slate-950 border border-slate-700 rounded-lg outline-none text-white"
              />
            </div>
          ) : (
            <div className="hidden md:block"></div>
          )}

          <div>
            <label className="text-slate-400 font-medium">
              {type === 'OLT_ZTE' ? 'SNMP Community (RO)' : 'Password API'}
            </label>
            <input
              required
              type="password"
              value={communityOrPass}
              onChange={(e) => setCommunityOrPass(e.target.value)}
              placeholder={type === 'OLT_ZTE' ? 'Community String' : 'Password'}
              className="w-full mt-1 px-3 py-2 bg-slate-950 border border-slate-700 rounded-lg outline-none text-white"
            />
          </div>

          <div className="md:col-span-3 flex justify-end mt-2">
            <button
              type="submit"
              disabled={submitting}
              className="px-5 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 rounded-lg font-semibold text-white transition"
            >
              {submitting ? 'Menyimpan...' : '+ Tambah Perangkat'}
            </button>
          </div>
        </form>

        {/* Tabel Daftar Perangkat */}
        <div className="mt-6">
          <div className="flex justify-between items-center mb-3">
            <span className="text-sm font-semibold text-slate-200">Daftar Gateway ({devices.length})</span>
            <button
              onClick={onRefresh}
              className="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-xs rounded-lg text-slate-300"
            >
              Refresh
            </button>
          </div>

          <div className="overflow-x-auto rounded-xl border border-slate-800">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-900/90 text-slate-400 uppercase text-[10px] tracking-wider">
                <tr>
                  <th className="p-3">Nama</th>
                  <th className="p-3">Tipe</th>
                  <th className="p-3">IP : Port</th>
                  <th className="p-3">Status</th>
                  <th className="p-3 text-right">Aksi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800 bg-slate-950/40">
                {devices.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="p-4 text-center text-slate-500">
                      Belum ada perangkat yang terdaftar
                    </td>
                  </tr>
                ) : (
                  devices.map((d) => (
                    <tr key={d.id} className="hover:bg-slate-800/40">
                      <td className="p-3 font-semibold text-white">{d.name}</td>
                      <td className="p-3">
                        <span className="px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-300">
                          {d.type}
                        </span>
                      </td>
                      <td className="p-3 font-mono text-slate-300">
                        {d.host}:{d.port}
                      </td>
                      <td className="p-3">
                        <span
                          className={`px-2 py-0.5 rounded text-[11px] font-medium ${
                            d.lastCheckStatus === 'CONNECTED'
                              ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                              : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                          }`}
                        >
                          {d.lastCheckStatus === 'CONNECTED'
                            ? `Terhubung (${d.lastCheckMessage || 'OK'})`
                            : d.lastCheckMessage || 'Belum Diuji / Terputus'}
                        </span>
                      </td>
                      <td className="p-3 text-right space-x-2">
                        <button
                          disabled={testingId === d.id}
                          onClick={() => handleTest(d.id)}
                          className="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 rounded text-white font-medium transition"
                        >
                          {testingId === d.id ? 'Menguji...' : 'Test'}
                        </button>
                        <button
                          onClick={() => onDeleteDevice(d.id)}
                          className="px-3 py-1 bg-rose-600 hover:bg-rose-500 rounded text-white font-medium transition"
                        >
                          Hapus
                        </button>
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
  );
};