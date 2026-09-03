import { startPingMonitor } from './monitoring/pingMonitor'
import { startPppoeMonitor } from './monitoring/pppoeMonitor'
import { startOltMonitor } from './monitoring/oltMonitor'
import { checkZteC320Onu, testOltConnection } from './olt/zteC320'
import express, { type NextFunction, type Request, type Response } from 'express'
import crypto from 'crypto'
import cors from 'cors'
import http from 'http'
import { Server } from 'socket.io'
import { prisma } from './prisma'
import type {
  Prisma,
  Cable,
  CableStatus,
  InstallationStatus,
  MonitoringLogEventType,
  MonitoringMethod,
  NetworkDevice,
  NetworkDeviceConnectionStatus,
  NetworkDeviceType,
  Node,
  NodeStatus,
  OnuStatus,
  UserAccess,
  UserRole,
} from './generated/prisma/client'

const app = express()
const PORT = Number(process.env.PORT || 4000)
const HOST = process.env.HOST || '0.0.0.0'
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*'
const corsOrigin = CORS_ORIGIN === '*'
  ? '*'
  : CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean)
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-this-before-production'
const TOKEN_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 7

app.use(cors({ origin: corsOrigin }))
app.use(express.json())

const httpServer = http.createServer(app)

const io = new Server(httpServer, {
  cors: {
    origin: corsOrigin,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  },
})

const allowedMonitoringMethods: MonitoringMethod[] = [
  'MANUAL',
  'PING',
  'PPPOE',
  'OLT',
  'SNMP',
]

const allowedNetworkDeviceTypes: NetworkDeviceType[] = ['MIKROTIK', 'OLT']

const allowedNetworkDeviceConnectionStatuses: NetworkDeviceConnectionStatus[] = [
  'UNKNOWN',
  'CONNECTED',
  'DISCONNECTED',
  'ERROR',
]

const allowedInstallationStatuses: InstallationStatus[] = [
  'PROSPECT',
  'REGISTERED',
  'INSTALLED',
  'ACTIVE',
  'SUSPENDED',
  'DISCONNECTED',
  'CANCELLED',
]

const allowedOnuStatuses: OnuStatus[] = [
  'ONLINE',
  'OFFLINE',
  'LOS',
  'DYING_GASP',
  'UNKNOWN',
]

const allowedUserRoles: UserRole[] = ['ADMIN', 'TECHNICIAN', 'SALES']
const allowedUserAccess: UserAccess[] = ['EDIT', 'VIEW']

interface AuthTokenPayload {
  userId: string
  exp: number
}

interface AuthenticatedRequest extends Request {
  authUser?: {
    id: string
    name: string
    username: string
    role: UserRole
    access: UserAccess
    isActive: boolean
  }
}

app.get('/', (req, res) => {
  res.json({
    message: 'Fiber Monitoring Backend with Database is running',
  })
})

app.post('/api/auth/bootstrap-admin', async (req, res) => {
  try {
    const existingUsers = await prisma.user.count()

    if (existingUsers > 0) {
      res.status(403).json({
        success: false,
        message: 'Bootstrap admin hanya bisa dilakukan saat belum ada user.',
      })
      return
    }

    const { name, username, password } = req.body

    if (!name || !username || !password) {
      res.status(400).json({
        success: false,
        message: 'Nama, username, dan password wajib diisi.',
      })
      return
    }

    if (String(password).length < 6) {
      res.status(400).json({
        success: false,
        message: 'Password minimal 6 karakter.',
      })
      return
    }

    const passwordHash = hashPassword(String(password))

    const user = await prisma.user.create({
      data: {
        name: String(name).trim(),
        username: String(username).trim().toLowerCase(),
        passwordHash,
        role: 'ADMIN',
        access: 'EDIT',
        isActive: true,
      },
    })

    res.status(201).json({
      success: true,
      message: 'Admin pertama berhasil dibuat.',
      user: sanitizeUser(user),
      token: createAuthToken(user.id),
    })
  } catch (error) {
    console.error(error)

    res.status(500).json({
      success: false,
      message: 'Gagal membuat admin pertama.',
    })
  }
})

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body

    if (!username || !password) {
      res.status(400).json({
        success: false,
        message: 'Username dan password wajib diisi.',
      })
      return
    }

    const user = await prisma.user.findUnique({
      where: {
        username: String(username).trim().toLowerCase(),
      },
    })

    if (!user || !verifyPassword(String(password), user.passwordHash)) {
      res.status(401).json({
        success: false,
        message: 'Username atau password salah.',
      })
      return
    }

    if (!user.isActive) {
      res.status(403).json({
        success: false,
        message: 'Akun ini sedang nonaktif.',
      })
      return
    }

    res.json({
      success: true,
      message: 'Login berhasil.',
      user: sanitizeUser(user),
      token: createAuthToken(user.id),
    })
  } catch (error) {
    console.error(error)

    res.status(500).json({
      success: false,
      message: 'Gagal login.',
    })
  }
})

app.get('/api/auth/me', requireAuth, async (req, res) => {
  const authReq = req as AuthenticatedRequest

  res.json({
    success: true,
    user: authReq.authUser,
  })
})

app.get('/api/users', requireAdmin, async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: {
        createdAt: 'desc',
      },
    })

    res.json({
      success: true,
      users: users.map(sanitizeUser),
    })
  } catch (error) {
    console.error(error)

    res.status(500).json({
      success: false,
      message: 'Gagal mengambil data user.',
    })
  }
})

app.post('/api/users', requireAdmin, async (req, res) => {
  try {
    const { name, username, password } = req.body
    const role = parseUserRole(req.body.role)
    const access = parseUserAccess(req.body.access)

    if (!name || !username || !password) {
      res.status(400).json({
        success: false,
        message: 'Nama, username, dan password wajib diisi.',
      })
      return
    }

    if (String(password).length < 6) {
      res.status(400).json({
        success: false,
        message: 'Password minimal 6 karakter.',
      })
      return
    }

    const finalRole = role || 'SALES'
    const finalAccess: UserAccess = finalRole === 'ADMIN' ? 'EDIT' : access || 'VIEW'

    const user = await prisma.user.create({
      data: {
        name: String(name).trim(),
        username: String(username).trim().toLowerCase(),
        passwordHash: hashPassword(String(password)),
        role: finalRole,
        access: finalAccess,
        isActive: req.body.isActive === undefined ? true : Boolean(req.body.isActive),
      },
    })

    res.status(201).json({
      success: true,
      message: 'User berhasil dibuat.',
      user: sanitizeUser(user),
    })
  } catch (error) {
    console.error(error)

    res.status(500).json({
      success: false,
      message: 'Gagal membuat user. Pastikan username belum dipakai.',
    })
  }
})

app.patch('/api/users/:id', requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id)
    const role = parseUserRole(req.body.role)
    const access = parseUserAccess(req.body.access)

    const updateData: {
      name?: string
      username?: string
      role?: UserRole
      access?: UserAccess
      isActive?: boolean
    } = {}

    if (req.body.name !== undefined) {
      updateData.name = String(req.body.name).trim()
    }

    if (req.body.username !== undefined) {
      updateData.username = String(req.body.username).trim().toLowerCase()
    }

    if (role) {
      updateData.role = role
    }

    if (access) {
      updateData.access = role === 'ADMIN' ? 'EDIT' : access
    }

    if (role === 'ADMIN') {
      updateData.access = 'EDIT'
    }

    if (req.body.isActive !== undefined) {
      updateData.isActive = Boolean(req.body.isActive)
    }

    const user = await prisma.user.update({
      where: {
        id,
      },
      data: updateData,
    })

    res.json({
      success: true,
      message: 'User berhasil diperbarui.',
      user: sanitizeUser(user),
    })
  } catch (error) {
    console.error(error)

    res.status(500).json({
      success: false,
      message: 'Gagal memperbarui user.',
    })
  }
})

app.patch('/api/users/:id/password', requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id)
    const { password } = req.body

    if (!password || String(password).length < 6) {
      res.status(400).json({
        success: false,
        message: 'Password baru minimal 6 karakter.',
      })
      return
    }

    const user = await prisma.user.update({
      where: {
        id,
      },
      data: {
        passwordHash: hashPassword(String(password)),
      },
    })

    res.json({
      success: true,
      message: 'Password user berhasil diperbarui.',
      user: sanitizeUser(user),
    })
  } catch (error) {
    console.error(error)

    res.status(500).json({
      success: false,
      message: 'Gagal memperbarui password user.',
    })
  }
})

app.patch('/api/users/:id/deactivate', requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id)

    const user = await prisma.user.update({
      where: {
        id,
      },
      data: {
        isActive: false,
      },
    })

    res.json({
      success: true,
      message: 'User berhasil dinonaktifkan.',
      user: sanitizeUser(user),
    })
  } catch (error) {
    console.error(error)

    res.status(500).json({
      success: false,
      message: 'Gagal menonaktifkan user.',
    })
  }
})

app.get('/api/network', async (req, res) => {
  try {
    const nodes = await prisma.node.findMany({
      orderBy: {
        id: 'asc',
      },
    })

    const cables = await prisma.cable.findMany({
      orderBy: {
        id: 'asc',
      },
    })

    res.json({
      nodes,
      cables,
    })
  } catch (error) {
    console.error(error)

    res.status(500).json({
      success: false,
      message: 'Gagal mengambil data network dari database',
    })
  }
})

app.post('/api/cables', requireEditAccess, async (req, res) => {
  try {
    const fromNodeId = String(req.body.fromNodeId || '').trim()
    const toNodeId = String(req.body.toNodeId || '').trim()
    const requestedType = String(req.body.type || 'DISTRIBUTION').trim()
    const requestedStatus = String(req.body.status || 'NORMAL').trim()
    const requestedName = String(req.body.name || '').trim()

    const allowedCableTypes = ['BACKBONE', 'DISTRIBUTION', 'DROP_WIRE'] as const
    const allowedCableStatuses = ['NORMAL', 'AFFECTED', 'BROKEN', 'UNKNOWN'] as const

    if (!fromNodeId || !toNodeId) {
      res.status(400).json({
        success: false,
        message: 'Node asal dan node tujuan wajib dipilih.',
      })
      return
    }

    if (fromNodeId === toNodeId) {
      res.status(400).json({
        success: false,
        message: 'Node asal dan node tujuan tidak boleh sama.',
      })
      return
    }

    if (!allowedCableTypes.includes(requestedType as (typeof allowedCableTypes)[number])) {
      res.status(400).json({
        success: false,
        message: 'Tipe kabel tidak valid.',
      })
      return
    }

    if (!allowedCableStatuses.includes(requestedStatus as (typeof allowedCableStatuses)[number])) {
      res.status(400).json({
        success: false,
        message: 'Status kabel tidak valid.',
      })
      return
    }

    const fromNode = await prisma.node.findUnique({
      where: {
        id: fromNodeId,
      },
    })

    const toNode = await prisma.node.findUnique({
      where: {
        id: toNodeId,
      },
    })

    if (!fromNode || !toNode) {
      res.status(404).json({
        success: false,
        message: 'Node asal atau node tujuan tidak ditemukan.',
      })
      return
    }

    const cableType = requestedType as (typeof allowedCableTypes)[number]
    const cableStatus = requestedStatus as (typeof allowedCableStatuses)[number]

    if (cableType === 'DROP_WIRE' && fromNode.type !== 'CLIENT' && toNode.type !== 'CLIENT') {
      res.status(400).json({
        success: false,
        message: 'DROP_WIRE harus terhubung ke node CLIENT. Untuk ODP ke ODP gunakan DISTRIBUTION.',
      })
      return
    }

    const existingCable = await prisma.cable.findFirst({
      where: {
        OR: [
          {
            fromNodeId,
            toNodeId,
          },
          {
            fromNodeId: toNodeId,
            toNodeId: fromNodeId,
          },
        ],
      },
    })

    if (existingCable) {
      res.status(409).json({
        success: false,
        message: 'Kabel antar node tersebut sudah ada.',
      })
      return
    }

    const cablePrefix = getCablePrefix(cableType)
    const safeIdPart = `${fromNodeId}-${toNodeId}`.replace(/[^a-zA-Z0-9_-]/g, '-')
    const generatedId = `${cablePrefix}-${safeIdPart}-${Date.now()}`
    const finalName = requestedName || `${getCableName(cableType)} ${fromNode.name} ke ${toNode.name}`

    const cable = await prisma.cable.create({
      data: {
        id: generatedId,
        name: finalName,
        type: cableType,
        fromNodeId,
        toNodeId,
        status: cableStatus,
        coordinates: [
          [fromNode.latitude, fromNode.longitude],
          [toNode.latitude, toNode.longitude],
        ],
      },
    })

    await createMonitoringLog({
      eventType: 'SYSTEM',
      title: 'Kabel baru ditambahkan',
      message: `${cable.name} berhasil ditambahkan.`,
      metadata: {
        cableId: cable.id,
        cableType: cable.type,
        fromNodeId,
        toNodeId,
        source: 'MANUAL_CABLE_CREATE',
      },
    })

    io.emit('cable-created', cable)

    res.status(201).json({
      success: true,
      message: 'Kabel berhasil ditambahkan.',
      cable,
    })
  } catch (error) {
    console.error(error)

    res.status(500).json({
      success: false,
      message: 'Gagal menambahkan kabel.',
    })
  }
})

app.patch('/api/cables/:id/route', requireEditAccess, async (req, res) => {
  try {
    const id = String(req.params.id)
    const inputCoordinates = req.body.coordinates

    const parsedCoordinates = parseCableRouteCoordinates(inputCoordinates)

    if (!parsedCoordinates) {
      res.status(400).json({
        success: false,
        message: 'Koordinat jalur kabel tidak valid. Minimal butuh titik awal dan akhir.',
      })
      return
    }

    const existingCable = await prisma.cable.findUnique({
      where: {
        id,
      },
    })

    if (!existingCable) {
      res.status(404).json({
        success: false,
        message: 'Kabel tidak ditemukan.',
      })
      return
    }

    const fromNode = await prisma.node.findUnique({
      where: {
        id: existingCable.fromNodeId,
      },
    })

    const toNode = await prisma.node.findUnique({
      where: {
        id: existingCable.toNodeId,
      },
    })

    if (!fromNode || !toNode) {
      res.status(404).json({
        success: false,
        message: 'Node asal atau node tujuan kabel tidak ditemukan.',
      })
      return
    }

    const bendPoints = parsedCoordinates.length > 2 ? parsedCoordinates.slice(1, -1) : []
    const finalCoordinates = [
      [fromNode.latitude, fromNode.longitude],
      ...bendPoints,
      [toNode.latitude, toNode.longitude],
    ]

    const updatedCable = await prisma.cable.update({
      where: {
        id,
      },
      data: {
        coordinates: finalCoordinates as Prisma.InputJsonValue,
      },
    })

    await createMonitoringLog({
      eventType: 'SYSTEM',
      title: 'Jalur kabel diperbarui',
      message: `${updatedCable.name} berhasil diperbarui jalurnya.`,
      metadata: {
        cableId: updatedCable.id,
        cableType: updatedCable.type,
        fromNodeId: updatedCable.fromNodeId,
        toNodeId: updatedCable.toNodeId,
        pointCount: finalCoordinates.length,
        source: 'MANUAL_CABLE_ROUTE_UPDATE',
      },
    })

    io.emit('cable-status-updated', updatedCable)

    res.json({
      success: true,
      message: 'Jalur kabel berhasil diperbarui.',
      cable: updatedCable,
    })
  } catch (error) {
    console.error(error)

    res.status(500).json({
      success: false,
      message: 'Gagal memperbarui jalur kabel.',
    })
  }
})

app.delete('/api/cables/:id', requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id)

    const existingCable = await prisma.cable.findUnique({
      where: {
        id,
      },
    })

    if (!existingCable) {
      res.status(404).json({
        success: false,
        message: 'Kabel tidak ditemukan.',
      })
      return
    }

    await prisma.cable.delete({
      where: {
        id,
      },
    })

    await createMonitoringLog({
      eventType: 'SYSTEM',
      title: 'Kabel dihapus',
      message: `${existingCable.name} berhasil dihapus.`,
      metadata: {
        cableId: existingCable.id,
        cableType: existingCable.type,
        fromNodeId: existingCable.fromNodeId,
        toNodeId: existingCable.toNodeId,
        source: 'MANUAL_CABLE_DELETE',
      },
    })

    io.emit('cable-deleted', {
      id,
    })

    res.json({
      success: true,
      message: 'Kabel berhasil dihapus.',
      deletedCableId: id,
    })
  } catch (error) {
    console.error(error)

    res.status(500).json({
      success: false,
      message: 'Gagal menghapus kabel.',
    })
  }
})

app.get('/api/monitoring-logs', requireAuth, async (req, res) => {
  try {
    const limitParam = Number(req.query.limit || 50)
    const limit = Number.isNaN(limitParam) ? 50 : Math.min(Math.max(limitParam, 1), 200)

    const logs = await prisma.monitoringLog.findMany({
      take: limit,
      orderBy: {
        createdAt: 'desc',
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

    res.json({
      success: true,
      logs,
    })
  } catch (error) {
    console.error(error)

    res.status(500).json({
      success: false,
      message: 'Gagal mengambil history log.',
    })
  }
})

app.get('/api/network-devices', requireAuth, async (req, res) => {
  try {
    const type = parseNetworkDeviceType(req.query.type)

    const devices = await prisma.networkDevice.findMany({
      where: type ? { type } : undefined,
      orderBy: [
        { type: 'asc' },
        { name: 'asc' },
      ],
    })

    res.json({
      success: true,
      devices: devices.map(sanitizeNetworkDevice),
    })
  } catch (error) {
    console.error(error)

    res.status(500).json({
      success: false,
      message: 'Gagal mengambil data perangkat monitoring.',
    })
  }
})

app.post('/api/network-devices', requireAdmin, async (req, res) => {
  try {
    const name = normalizeOptionalString(req.body.name)
    const type = parseNetworkDeviceType(req.body.type)
    const host = normalizeOptionalString(req.body.host)
    const port = parseOptionalNumber(req.body.port)
    const username = normalizeOptionalString(req.body.username)
    const password = normalizeOptionalString(req.body.password)
    const brand = normalizeOptionalString(req.body.brand)
    const model = normalizeOptionalString(req.body.model)
    const notes = normalizeOptionalString(req.body.notes)

    if (!name || !type || !host) {
      res.status(400).json({
        success: false,
        message: 'Nama perangkat, tipe, dan host/IP wajib diisi.',
      })
      return
    }

    const device = await prisma.networkDevice.create({
      data: {
        name,
        type,
        host,
        port: port || getDefaultNetworkDevicePort(type),
        username,
        passwordEncrypted: encryptSecret(password),
        brand,
        model,
        notes,
        isActive: typeof req.body.isActive === 'boolean' ? req.body.isActive : true,
        connectionStatus: 'UNKNOWN',
      },
    })

    res.status(201).json({
      success: true,
      message: 'Perangkat monitoring berhasil ditambahkan.',
      device: sanitizeNetworkDevice(device),
    })
  } catch (error) {
    console.error(error)

    res.status(500).json({
      success: false,
      message: 'Gagal menambahkan perangkat monitoring.',
    })
  }
})

app.patch('/api/network-devices/:id', requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id)

    const existingDevice = await prisma.networkDevice.findUnique({
      where: { id },
    })

    if (!existingDevice) {
      res.status(404).json({
        success: false,
        message: 'Perangkat monitoring tidak ditemukan.',
      })
      return
    }

    const nextType =
      req.body.type !== undefined
        ? parseNetworkDeviceType(req.body.type) || existingDevice.type
        : existingDevice.type

    const nextPort =
      req.body.port !== undefined
        ? parseOptionalNumber(req.body.port) || getDefaultNetworkDevicePort(nextType)
        : existingDevice.port

    const nextPasswordEncrypted =
      req.body.password !== undefined
        ? encryptSecret(normalizeOptionalString(req.body.password))
        : existingDevice.passwordEncrypted

    const device = await prisma.networkDevice.update({
      where: { id },
      data: {
        name: valueOrExistingString(req.body.name, existingDevice.name) || existingDevice.name,
        type: nextType,
        host: valueOrExistingString(req.body.host, existingDevice.host) || existingDevice.host,
        port: nextPort,
        username: valueOrExistingString(req.body.username, existingDevice.username),
        passwordEncrypted: nextPasswordEncrypted,
        brand: valueOrExistingString(req.body.brand, existingDevice.brand),
        model: valueOrExistingString(req.body.model, existingDevice.model),
        notes: valueOrExistingString(req.body.notes, existingDevice.notes),
        isActive:
          typeof req.body.isActive === 'boolean'
            ? req.body.isActive
            : existingDevice.isActive,
      },
    })

    res.json({
      success: true,
      message: 'Perangkat monitoring berhasil diperbarui.',
      device: sanitizeNetworkDevice(device),
    })
  } catch (error) {
    console.error(error)

    res.status(500).json({
      success: false,
      message: 'Gagal memperbarui perangkat monitoring.',
    })
  }
})

app.delete('/api/network-devices/:id', requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id)

    const existingDevice = await prisma.networkDevice.findUnique({
      where: { id },
      include: {
        mikrotikClients: { select: { id: true } },
        oltClients: { select: { id: true } },
      },
    })

    if (!existingDevice) {
      res.status(404).json({
        success: false,
        message: 'Perangkat monitoring tidak ditemukan.',
      })
      return
    }

    const usedByClientCount = existingDevice.mikrotikClients.length + existingDevice.oltClients.length

    if (usedByClientCount > 0) {
      const device = await prisma.networkDevice.update({
        where: { id },
        data: { isActive: false },
      })

      res.json({
        success: true,
        message: 'Perangkat masih dipakai client, jadi hanya dinonaktifkan.',
        device: sanitizeNetworkDevice(device),
      })
      return
    }

    await prisma.networkDevice.delete({
      where: { id },
    })

    res.json({
      success: true,
      message: 'Perangkat monitoring berhasil dihapus.',
      id,
    })
  } catch (error) {
    console.error(error)

    res.status(500).json({
      success: false,
      message: 'Gagal menghapus perangkat monitoring.',
    })
  }
})

app.post('/api/network-devices/:id/test', requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id)

    const device = await prisma.networkDevice.findUnique({
      where: { id },
    })

    if (!device) {
      res.status(404).json({
        success: false,
        message: 'Perangkat monitoring tidak ditemukan.',
      })
      return
    }

    if (device.type === 'OLT') {
      const community = decryptSecret(device.passwordEncrypted) || 'public'
      try {
        const result = await testOltConnection({
          host: device.host,
          port: device.port || 161,
          community,
          timeoutMs: 4000,
        })

        const updatedDevice = await prisma.networkDevice.update({
          where: { id },
          data: {
            connectionStatus: 'CONNECTED',
            lastConnectedAt: new Date(),
            lastConnectionMessage: result.message,
          },
        })

        res.json({
          success: true,
          message: result.message,
          device: sanitizeNetworkDevice(updatedDevice),
        })
        return
      } catch (snmpErr: any) {
        const updatedDevice = await prisma.networkDevice.update({
          where: { id },
          data: {
            connectionStatus: 'ERROR',
            lastConnectionMessage: snmpErr.message || 'Gagal konek SNMP OLT',
          },
        })

        res.json({
          success: false,
          message: snmpErr.message || 'Gagal konek SNMP OLT',
          device: sanitizeNetworkDevice(updatedDevice),
        })
        return
      }
    }

    const updatedDevice = await prisma.networkDevice.update({
      where: { id },
      data: {
        connectionStatus: 'CONNECTED',
        lastConnectedAt: new Date(),
        lastConnectionMessage: `Koneksi MikroTik ke ${device.host}:${device.port} valid.`,
      },
    })

    res.json({
      success: true,
      message: `Data perangkat MikroTik valid (${device.host}:${device.port}).`,
      device: sanitizeNetworkDevice(updatedDevice),
    })
  } catch (error) {
    console.error(error)

    res.status(500).json({
      success: false,
      message: 'Gagal mengetes perangkat monitoring.',
    })
  }
})

app.get('/api/olt/test', requireAdmin, async (req, res) => {
  try {
    const result = await testOltConnection()

    res.json({
      success: true,
      message: 'Koneksi SNMP OLT berhasil.',
      olt: {
        host: result.host,
        port: process.env.OLT_PORT || 161,
        sysName: result.sysName,
      },
      output: result.output,
    })
  } catch (error) {
    console.error('OLT SNMP TEST ERROR:', error)

    res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : 'Gagal query SNMP ke OLT.',
    })
  }
})

app.post('/api/olt/check-onu', requireEditAccess, async (req, res) => {
  try {
    const onuInterface = String(req.body.onuInterface || '').trim()
    const nodeId = req.body.nodeId ? String(req.body.nodeId).trim() : null

    if (!onuInterface) {
      res.status(400).json({
        success: false,
        message: 'onuInterface wajib diisi. Contoh: gpon-onu_1/1/1:11',
      })
      return
    }

    const result = await checkZteC320Onu(onuInterface)
    const rxWarningLimit = Number(process.env.OLT_RX_WARNING_DBM || -27)

    let mappedNodeStatus: NodeStatus = 'UNKNOWN'

    if (result.onuStatus === 'ONLINE') {
      mappedNodeStatus =
        result.onuRxPower !== null && result.onuRxPower <= rxWarningLimit
          ? 'WARNING'
          : 'ONLINE'
    } else if (
      result.onuStatus === 'OFFLINE' ||
      result.onuStatus === 'LOS' ||
      (result.onuStatus as string) === 'DYING_GASP'
    ) {
      mappedNodeStatus = 'OFFLINE'
    }

    let updatedNode: Node | null = null

    if (nodeId) {
      const existingNode = await prisma.node.findUnique({
        where: {
          id: nodeId,
        },
      })

      if (!existingNode) {
        res.status(404).json({
          success: false,
          message: 'Node client tidak ditemukan.',
        })
        return
      }

      updatedNode = await prisma.node.update({
        where: {
          id: nodeId,
        },
        data: {
          status: mappedNodeStatus,
          monitoringMethod: 'OLT',
          monitoringEnabled: true,
          onuInterface: result.onuInterface,
          onuStatus: result.onuStatus,
          onuRxPower: result.onuRxPower,
          onuLastCheckedAt: new Date(),
          rxPower: result.onuRxPower,
          lastCheckedAt: new Date(),
          lastSeenAt: mappedNodeStatus === 'ONLINE' ? new Date() : existingNode.lastSeenAt,
          offlineSince:
            mappedNodeStatus === 'OFFLINE'
              ? existingNode.offlineSince || new Date()
              : null,
        },
      })

      io.emit('node-status-updated', updatedNode)

      if (existingNode.status !== updatedNode.status) {
        await createMonitoringLog({
          nodeId: updatedNode.id,
          eventType: getMonitoringLogEventType(updatedNode.status),
          oldStatus: existingNode.status,
          newStatus: updatedNode.status,
          title:
            updatedNode.status === 'ONLINE'
              ? 'ONU ONLINE'
              : updatedNode.status === 'OFFLINE'
                ? 'ONU OFFLINE'
                : updatedNode.status === 'WARNING'
                  ? 'ONU WARNING'
                  : 'ONU UNKNOWN',
          message:
            updatedNode.status === 'ONLINE'
              ? `${updatedNode.name} online dari SNMP OLT.`
              : updatedNode.status === 'OFFLINE'
                ? `${updatedNode.name} offline/LOS dari SNMP OLT.`
                : updatedNode.status === 'WARNING'
                  ? `${updatedNode.name} warning dari SNMP OLT. RX ${result.onuRxPower ?? '-'} dBm.`
                  : `${updatedNode.name} status SNMP OLT tidak diketahui.`,
          metadata: {
            source: 'OLT_ZTE_C320_SNMP_MANUAL_CHECK',
            onuInterface: result.onuInterface,
            onuStatus: result.onuStatus,
            onuRxPower: result.onuRxPower,
            rawStatusText: result.rawStatusText,
          },
        })
      }
    }

    res.json({
      success: true,
      message: 'Cek SNMP ONU selesai.',
      result: {
        onuInterface: result.onuInterface,
        onuStatus: result.onuStatus,
        onuRxPower: result.onuRxPower,
        rawStatusText: result.rawStatusText,
        mappedNodeStatus,
      },
      updatedNode,
      rawOutput: result.rawOutput,
    })
  } catch (error) {
    console.error('OLT SNMP CHECK ONU ERROR:', error)

    res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : 'Gagal query SNMP ONU ke OLT.',
    })
  }
})

app.get('/api/nodes/generate-id/:type', async (req, res) => {
  try {
    const type = String(req.params.type)

    const allowedTypes = ['OLT', 'POLE', 'ODP', 'CLIENT', 'ROUTER']

    if (!allowedTypes.includes(type)) {
      return res.status(400).json({
        success: false,
        message: 'Tipe node tidak valid.',
      })
    }

    const prefixMap: Record<string, string> = {
      OLT: 'olt',
      POLE: 'pole',
      ODP: 'odp',
      CLIENT: 'client',
      ROUTER: 'router',
    }

    const prefix = prefixMap[type]

    const existingNodes = await prisma.node.findMany({
      where: {
        id: {
          startsWith: `${prefix}-`,
        },
      },
      select: {
        id: true,
      },
    })

    let maxNumber = 0

    for (const node of existingNodes) {
      const numberPart = node.id.replace(`${prefix}-`, '')
      const parsedNumber = Number(numberPart)

      if (!Number.isNaN(parsedNumber) && parsedNumber > maxNumber) {
        maxNumber = parsedNumber
      }
    }

    const nextNumber = maxNumber + 1
    const generatedId = `${prefix}-${String(nextNumber).padStart(4, '0')}`

    res.json({
      success: true,
      id: generatedId,
    })
  } catch (error) {
    console.error(error)

    res.status(500).json({
      success: false,
      message: 'Gagal membuat ID otomatis.',
    })
  }
})

app.post('/api/nodes', requireEditAccess, async (req, res) => {
  try {
    const {
      id,
      name,
      type,
      ipAddress,
      latitude,
      longitude,
      status,
      rxPower,
      parentId,
      pppoeUsername,
      monitoringEnabled,
      monitoringMethod,
      mikrotikDeviceId,
      oltDeviceId,
      customerName,
      customerPhone,
      customerAddress,
      installationStatus,
      installationDate,
      salesName,
      technicianName,
      notes,
      photoUrl,
      odpSlotCapacity,
      odpInputPort,
      odpOutputPort,
      oltHost,
      oltPort,
      oltUsername,
      oltPasswordEncrypted,
      ponPort,
      onuId,
      onuInterface,
      onuSerialNumber,
      onuStatus,
      onuRxPower,
      onuLastCheckedAt,
    } = req.body

    if (!id || !name || !type || latitude === undefined || longitude === undefined) {
      return res.status(400).json({
        success: false,
        message: 'id, name, type, latitude, dan longitude wajib diisi.',
      })
    }

    const finalMonitoringMethod: MonitoringMethod =
      monitoringMethod && allowedMonitoringMethods.includes(monitoringMethod)
        ? monitoringMethod
        : 'MANUAL'

    const finalInstallationStatus = parseInstallationStatus(installationStatus)
    const finalOnuStatus = parseOnuStatus(onuStatus)

    const existingNode = await prisma.node.findUnique({
      where: {
        id,
      },
    })

    if (existingNode) {
      return res.status(409).json({
        success: false,
        message: 'Node dengan ID tersebut sudah ada.',
      })
    }

    let parentNode = null

    if (parentId) {
      parentNode = await prisma.node.findUnique({
        where: {
          id: parentId,
        },
      })

      if (!parentNode) {
        return res.status(404).json({
          success: false,
          message: 'Parent / induk tidak ditemukan.',
        })
      }

      if (parentId === id) {
        return res.status(400).json({
          success: false,
          message: 'Node tidak boleh menjadi parent untuk dirinya sendiri.',
        })
      }
    }

    await validateNodeMonitoringDevices({
      monitoringMethod: finalMonitoringMethod,
      mikrotikDeviceId,
      oltDeviceId,
    })

    const newNode = await prisma.node.create({
      data: {
        id,
        name,
        type,
        ipAddress: ipAddress || null,
        latitude: Number(latitude),
        longitude: Number(longitude),
        status: status || 'UNKNOWN',
        rxPower:
          rxPower !== undefined && rxPower !== null && rxPower !== ''
            ? Number(rxPower)
            : null,
        parentId: parentId || null,

        pppoeUsername: pppoeUsername || null,
        monitoringEnabled:
          typeof monitoringEnabled === 'boolean' ? monitoringEnabled : false,
        monitoringMethod: finalMonitoringMethod,
        mikrotikDeviceId: normalizeOptionalString(mikrotikDeviceId),
        oltDeviceId: normalizeOptionalString(oltDeviceId),
        lastCheckedAt: null,
        lastSeenAt: null,
        latencyMs: null,

        customerName: normalizeOptionalString(customerName),
        customerPhone: normalizeOptionalString(customerPhone),
        customerAddress: normalizeOptionalString(customerAddress),
        installationStatus: finalInstallationStatus,
        installationDate: parseOptionalDate(installationDate),
        salesName: normalizeOptionalString(salesName),
        technicianName: normalizeOptionalString(technicianName),
        notes: normalizeOptionalString(notes),
        photoUrl: normalizeOptionalString(photoUrl),

        odpSlotCapacity: parseOptionalNumber(odpSlotCapacity),
        odpInputPort: normalizeOptionalString(odpInputPort),
        odpOutputPort: normalizeOptionalString(odpOutputPort),

        oltHost: normalizeOptionalString(oltHost),
        oltPort: parseOptionalNumber(oltPort),
        oltUsername: normalizeOptionalString(oltUsername),
        oltPasswordEncrypted: normalizeOptionalString(oltPasswordEncrypted),

        ponPort: normalizeOptionalString(ponPort),
        onuId: parseOptionalNumber(onuId),
        onuInterface: normalizeOptionalString(onuInterface),
        onuSerialNumber: normalizeOptionalString(onuSerialNumber),
        onuStatus: finalOnuStatus,
        onuRxPower: parseOptionalNumber(onuRxPower),
        onuLastCheckedAt: parseOptionalDate(onuLastCheckedAt),
      },
    })

    await createMonitoringLog({
      nodeId: newNode.id,
      eventType: newNode.type === 'CLIENT' ? 'CLIENT_CREATED' : 'SYSTEM',
      newStatus: newNode.status,
      title: 'Node baru ditambahkan',
      message: `${newNode.name} berhasil ditambahkan ke sistem.`,
      metadata: {
        nodeType: newNode.type,
        parentId: newNode.parentId,
      },
    })

    let newCable = null

    if (parentNode) {
      const cableType = getAutomaticCableType(newNode.type, parentNode.type)

      if (cableType) {
        const cablePrefix = getCablePrefix(cableType)

        newCable = await prisma.cable.create({
          data: {
            id: `${cablePrefix}-${parentNode.id}-${newNode.id}`,
            name: `${getCableName(cableType)} ${parentNode.name} ke ${newNode.name}`,
            type: cableType,
            fromNodeId: parentNode.id,
            toNodeId: newNode.id,
            status: newNode.status === 'OFFLINE' ? 'BROKEN' : 'NORMAL',
            coordinates: [
              [parentNode.latitude, parentNode.longitude],
              [newNode.latitude, newNode.longitude],
            ],
          },
        })
      }
    }

    io.emit('node-created', newNode)

    if (newCable) {
      io.emit('cable-created', newCable)
    }

    res.status(201).json({
      success: true,
      message: newCable
        ? 'Node baru dan kabel otomatis berhasil ditambahkan.'
        : 'Node baru berhasil ditambahkan.',
      node: newNode,
      cable: newCable,
    })
  } catch (error) {
    console.error(error)

    res.status(500).json({
      success: false,
      message: 'Gagal menambahkan node baru.',
    })
  }
})

app.patch('/api/nodes/:id/status', requireEditAccess, async (req, res) => {
  try {
    const id = String(req.params.id)

    const { status, rxPower, latencyMs } = req.body as {
      status: NodeStatus
      rxPower?: number
      latencyMs?: number
    }

    const allowedStatus: NodeStatus[] = ['ONLINE', 'OFFLINE', 'WARNING', 'UNKNOWN']

    if (!allowedStatus.includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Status tidak valid. Gunakan ONLINE, OFFLINE, WARNING, atau UNKNOWN.',
      })
    }

    const existingNode = await prisma.node.findUnique({
      where: {
        id,
      },
    })

    if (!existingNode) {
      return res.status(404).json({
        success: false,
        message: 'Node tidak ditemukan',
      })
    }

    const now = new Date()

    const updatedNode = await prisma.node.update({
      where: {
        id,
      },
      data: {
        status,
        rxPower:
          rxPower !== undefined && rxPower !== null
            ? Number(rxPower)
            : existingNode.rxPower,
        latencyMs:
          latencyMs !== undefined && latencyMs !== null
            ? Number(latencyMs)
            : existingNode.latencyMs,
        lastCheckedAt: now,
        lastSeenAt: status === 'ONLINE' ? now : existingNode.lastSeenAt,
        offlineSince:
          status === 'OFFLINE' ? existingNode.offlineSince || now : null,
      },
    })

    if (existingNode.status !== updatedNode.status) {
      await createMonitoringLog({
        nodeId: updatedNode.id,
        eventType: getMonitoringLogEventType(updatedNode.status),
        oldStatus: existingNode.status,
        newStatus: updatedNode.status,
        title: 'Status node berubah',
        message: `${updatedNode.name} berubah dari ${existingNode.status} menjadi ${updatedNode.status}.`,
        metadata: {
          rxPower: updatedNode.rxPower,
          latencyMs: updatedNode.latencyMs,
        },
      })
    }

    const affectedCables = await updateCableStatusByNode(id, status)
    const recalculatedTopology = await recalculateOdpStatusByClient(id)

    io.emit('node-status-updated', updatedNode)

    affectedCables.forEach((cable) => {
      io.emit('cable-status-updated', cable)
    })

    recalculatedTopology.updatedNodes.forEach((node) => {
      io.emit('node-status-updated', node)
    })

    recalculatedTopology.updatedCables.forEach((cable) => {
      io.emit('cable-status-updated', cable)
    })

    res.json({
      success: true,
      message: 'Status node berhasil diupdate dan topologi dihitung ulang',
      node: updatedNode,
      affectedCables,
      recalculatedTopology,
    })
  } catch (error) {
    console.error(error)

    res.status(500).json({
      success: false,
      message: 'Gagal update status node',
    })
  }
})

app.patch('/api/nodes/:id', requireEditAccess, async (req, res) => {
  try {
    const id = String(req.params.id)

    const {
      name,
      type,
      ipAddress,
      status,
      rxPower,
      parentId,
      pppoeUsername,
      monitoringEnabled,
      monitoringMethod,
      mikrotikDeviceId,
      oltDeviceId,
      customerName,
      customerPhone,
      customerAddress,
      installationStatus,
      installationDate,
      salesName,
      technicianName,
      notes,
      photoUrl,
      odpSlotCapacity,
      odpInputPort,
      odpOutputPort,
      oltHost,
      oltPort,
      oltUsername,
      oltPasswordEncrypted,
      ponPort,
      onuId,
      onuInterface,
      onuSerialNumber,
      onuStatus,
      onuRxPower,
      onuLastCheckedAt,
    } = req.body

    const existingNode = await prisma.node.findUnique({
      where: {
        id,
      },
    })

    if (!existingNode) {
      return res.status(404).json({
        success: false,
        message: 'Node tidak ditemukan.',
      })
    }

    const finalMonitoringMethod: MonitoringMethod =
      monitoringMethod && allowedMonitoringMethods.includes(monitoringMethod)
        ? monitoringMethod
        : existingNode.monitoringMethod

    const finalInstallationStatus =
      installationStatus !== undefined
        ? parseInstallationStatus(installationStatus)
        : existingNode.installationStatus

    const finalOnuStatus =
      onuStatus !== undefined ? parseOnuStatus(onuStatus) : existingNode.onuStatus

    const finalParentId =
      parentId !== undefined ? parentId || null : existingNode.parentId

    let parentNode = null

    if (finalParentId) {
      parentNode = await prisma.node.findUnique({
        where: {
          id: finalParentId,
        },
      })

      if (!parentNode) {
        return res.status(404).json({
          success: false,
          message: 'Parent / induk tidak ditemukan.',
        })
      }

      if (finalParentId === id) {
        return res.status(400).json({
          success: false,
          message: 'Node tidak boleh menjadi parent untuk dirinya sendiri.',
        })
      }
    }

    const finalMikrotikDeviceId =
      mikrotikDeviceId !== undefined
        ? normalizeOptionalString(mikrotikDeviceId)
        : existingNode.mikrotikDeviceId

    const finalOltDeviceId =
      oltDeviceId !== undefined
        ? normalizeOptionalString(oltDeviceId)
        : existingNode.oltDeviceId

    await validateNodeMonitoringDevices({
      monitoringMethod: finalMonitoringMethod,
      mikrotikDeviceId: finalMikrotikDeviceId,
      oltDeviceId: finalOltDeviceId,
    })

    const updatedNode = await prisma.node.update({
      where: {
        id,
      },
      data: {
        name: name !== undefined ? name : existingNode.name,
        type: type !== undefined ? type : existingNode.type,
        ipAddress:
          ipAddress !== undefined ? ipAddress || null : existingNode.ipAddress,
        status: status !== undefined ? status : existingNode.status,
        rxPower:
          rxPower !== undefined && rxPower !== null && rxPower !== ''
            ? Number(rxPower)
            : rxPower === ''
              ? null
              : existingNode.rxPower,
        parentId: finalParentId,

        pppoeUsername:
          pppoeUsername !== undefined
            ? pppoeUsername || null
            : existingNode.pppoeUsername,
        monitoringEnabled:
          typeof monitoringEnabled === 'boolean'
            ? monitoringEnabled
            : existingNode.monitoringEnabled,
        monitoringMethod: finalMonitoringMethod,
        mikrotikDeviceId: finalMikrotikDeviceId,
        oltDeviceId: finalOltDeviceId,

        customerName: valueOrExistingString(customerName, existingNode.customerName),
        customerPhone: valueOrExistingString(customerPhone, existingNode.customerPhone),
        customerAddress: valueOrExistingString(customerAddress, existingNode.customerAddress),
        installationStatus: finalInstallationStatus,
        installationDate: valueOrExistingDate(installationDate, existingNode.installationDate),
        salesName: valueOrExistingString(salesName, existingNode.salesName),
        technicianName: valueOrExistingString(technicianName, existingNode.technicianName),
        notes: valueOrExistingString(notes, existingNode.notes),
        photoUrl: valueOrExistingString(photoUrl, existingNode.photoUrl),

        odpSlotCapacity: valueOrExistingNumber(odpSlotCapacity, existingNode.odpSlotCapacity),
        odpInputPort: valueOrExistingString(odpInputPort, existingNode.odpInputPort),
        odpOutputPort: valueOrExistingString(odpOutputPort, existingNode.odpOutputPort),

        oltHost: valueOrExistingString(oltHost, existingNode.oltHost),
        oltPort: valueOrExistingNumber(oltPort, existingNode.oltPort),
        oltUsername: valueOrExistingString(oltUsername, existingNode.oltUsername),
        oltPasswordEncrypted: valueOrExistingString(
          oltPasswordEncrypted,
          existingNode.oltPasswordEncrypted,
        ),

        ponPort: valueOrExistingString(ponPort, existingNode.ponPort),
        onuId: valueOrExistingNumber(onuId, existingNode.onuId),
        onuInterface: valueOrExistingString(onuInterface, existingNode.onuInterface),
        onuSerialNumber: valueOrExistingString(
          onuSerialNumber,
          existingNode.onuSerialNumber,
        ),
        onuStatus: finalOnuStatus,
        onuRxPower: valueOrExistingNumber(onuRxPower, existingNode.onuRxPower),
        onuLastCheckedAt: valueOrExistingDate(
          onuLastCheckedAt,
          existingNode.onuLastCheckedAt,
        ),
      },
    })

    await createMonitoringLog({
      nodeId: updatedNode.id,
      eventType: updatedNode.type === 'CLIENT' ? 'CLIENT_UPDATED' : 'SYSTEM',
      oldStatus: existingNode.status,
      newStatus: updatedNode.status,
      title: 'Data node diperbarui',
      message: `${updatedNode.name} berhasil diperbarui.`,
      metadata: {
        nodeType: updatedNode.type,
        oldParentId: existingNode.parentId,
        newParentId: updatedNode.parentId,
      },
    })

    let updatedCable = null
    let deletedCableId: string | null = null

    const parentChanged = existingNode.parentId !== finalParentId

    if (parentChanged) {
      const existingCable = await prisma.cable.findFirst({
        where: {
          toNodeId: updatedNode.id,
        },
      })

      const newCableType = parentNode
        ? getAutomaticCableType(updatedNode.type, parentNode.type)
        : null

      if (parentNode && newCableType) {
        if (existingCable) {
          updatedCable = await prisma.cable.update({
            where: {
              id: existingCable.id,
            },
            data: {
              name: `${getCableName(newCableType)} ${parentNode.name} ke ${updatedNode.name}`,
              type: newCableType,
              fromNodeId: parentNode.id,
              toNodeId: updatedNode.id,
              status: updatedNode.status === 'OFFLINE' ? 'BROKEN' : 'NORMAL',
              coordinates: [
                [parentNode.latitude, parentNode.longitude],
                [updatedNode.latitude, updatedNode.longitude],
              ],
            },
          })
        } else {
          const cablePrefix = getCablePrefix(newCableType)

          updatedCable = await prisma.cable.create({
            data: {
              id: `${cablePrefix}-${parentNode.id}-${updatedNode.id}`,
              name: `${getCableName(newCableType)} ${parentNode.name} ke ${updatedNode.name}`,
              type: newCableType,
              fromNodeId: parentNode.id,
              toNodeId: updatedNode.id,
              status: updatedNode.status === 'OFFLINE' ? 'BROKEN' : 'NORMAL',
              coordinates: [
                [parentNode.latitude, parentNode.longitude],
                [updatedNode.latitude, updatedNode.longitude],
              ],
            },
          })
        }
      } else if (existingCable) {
        deletedCableId = existingCable.id

        await prisma.cable.delete({
          where: {
            id: existingCable.id,
          },
        })
      }
    } else {
      const existingCable = await prisma.cable.findFirst({
        where: {
          toNodeId: updatedNode.id,
        },
        include: {
          fromNode: true,
          toNode: true,
        },
      })

      if (existingCable) {
        updatedCable = await prisma.cable.update({
          where: {
            id: existingCable.id,
          },
          data: {
            name: `${getCableName(existingCable.type)} ${existingCable.fromNode.name} ke ${updatedNode.name}`,
            status: updatedNode.status === 'OFFLINE' ? 'BROKEN' : 'NORMAL',
            coordinates: [
              [existingCable.fromNode.latitude, existingCable.fromNode.longitude],
              [updatedNode.latitude, updatedNode.longitude],
            ],
          },
        })
      }
    }

    const recalculatedTopology =
      updatedNode.type === 'CLIENT'
        ? await recalculateOdpStatusByClient(updatedNode.id)
        : { updatedNodes: [], updatedCables: [] }

    io.emit('node-status-updated', updatedNode)

    if (updatedCable) {
      io.emit('cable-status-updated', updatedCable)
    }

    if (deletedCableId) {
      io.emit('cable-deleted', {
        id: deletedCableId,
      })
    }

    recalculatedTopology.updatedNodes.forEach((node) => {
      io.emit('node-status-updated', node)
    })

    recalculatedTopology.updatedCables.forEach((cable) => {
      io.emit('cable-status-updated', cable)
    })

    res.json({
      success: true,
      message: 'Data node berhasil diperbarui.',
      node: updatedNode,
      cable: updatedCable,
      deletedCableId,
      recalculatedTopology,
    })
  } catch (error) {
    console.error(error)

    res.status(500).json({
      success: false,
      message: 'Gagal memperbarui data node.',
    })
  }
})

app.patch('/api/nodes/:id/position', requireEditAccess, async (req, res) => {
  try {
    const id = String(req.params.id)
    const { latitude, longitude } = req.body as {
      latitude: number
      longitude: number
    }

    if (latitude === undefined || longitude === undefined) {
      return res.status(400).json({
        success: false,
        message: 'Latitude dan longitude wajib diisi.',
      })
    }

    const existingNode = await prisma.node.findUnique({
      where: {
        id,
      },
    })

    if (!existingNode) {
      return res.status(404).json({
        success: false,
        message: 'Node tidak ditemukan.',
      })
    }

    const updatedNode = await prisma.node.update({
      where: {
        id,
      },
      data: {
        latitude: Number(latitude),
        longitude: Number(longitude),
      },
    })

    const relatedCables = await prisma.cable.findMany({
      where: {
        OR: [
          {
            fromNodeId: id,
          },
          {
            toNodeId: id,
          },
        ],
      },
    })

    const updatedCables: Cable[] = []

    for (const cable of relatedCables) {
      const fromNode =
        cable.fromNodeId === id
          ? updatedNode
          : await prisma.node.findUnique({
              where: {
                id: cable.fromNodeId,
              },
            })

      const toNode =
        cable.toNodeId === id
          ? updatedNode
          : await prisma.node.findUnique({
              where: {
                id: cable.toNodeId,
              },
            })

      if (!fromNode || !toNode) continue

      const updatedCable = await prisma.cable.update({
        where: {
          id: cable.id,
        },
        data: {
          coordinates: [
            [fromNode.latitude, fromNode.longitude],
            [toNode.latitude, toNode.longitude],
          ],
        },
      })

      updatedCables.push(updatedCable)
    }

    io.emit('node-position-updated', updatedNode)

    updatedCables.forEach((cable) => {
      io.emit('cable-status-updated', cable)
    })

    res.json({
      success: true,
      message: 'Posisi node berhasil diperbarui.',
      node: updatedNode,
      cables: updatedCables,
    })
  } catch (error) {
    console.error(error)

    res.status(500).json({
      success: false,
      message: 'Gagal memperbarui posisi node.',
    })
  }
})

app.delete('/api/nodes/:id', requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id)

    const existingNode = await prisma.node.findUnique({
      where: {
        id,
      },
    })

    if (!existingNode) {
      return res.status(404).json({
        success: false,
        message: 'Node tidak ditemukan.',
      })
    }

    const children = await prisma.node.findMany({
      where: {
        parentId: id,
      },
    })

    if (children.length > 0) {
      return res.status(409).json({
        success: false,
        message:
          'Node ini masih memiliki child/client di bawahnya. Hapus atau pindahkan child terlebih dahulu.',
      })
    }

    const relatedCables = await prisma.cable.findMany({
      where: {
        OR: [
          {
            fromNodeId: id,
          },
          {
            toNodeId: id,
          },
        ],
      },
    })

    await prisma.cable.deleteMany({
      where: {
        OR: [
          {
            fromNodeId: id,
          },
          {
            toNodeId: id,
          },
        ],
      },
    })

    await prisma.node.delete({
      where: {
        id,
      },
    })

    relatedCables.forEach((cable) => {
      io.emit('cable-deleted', {
        id: cable.id,
      })
    })

    io.emit('node-deleted', {
      id,
    })

    res.json({
      success: true,
      message: 'Node dan kabel terkait berhasil dihapus.',
      deletedNodeId: id,
      deletedCableIds: relatedCables.map((cable) => cable.id),
    })
  } catch (error) {
    console.error(error)

    res.status(500).json({
      success: false,
      message: 'Gagal menghapus node.',
    })
  }
})

app.get('/api/faults/analyze', async (req, res) => {
  try {
    const nodes = await prisma.node.findMany({
      orderBy: {
        id: 'asc',
      },
    })

    const cables = await prisma.cable.findMany({
      orderBy: {
        id: 'asc',
      },
    })

    const odps = nodes.filter((node) => node.type === 'ODP')
    const alerts = []

    for (const odp of odps) {
      const clients = nodes.filter(
        (node) => node.type === 'CLIENT' && node.parentId === odp.id,
      )

      if (clients.length === 0) continue

      const offlineClients = clients.filter(
        (client) => client.status === 'OFFLINE',
      )

      if (offlineClients.length === 0) continue

      const cableToOdp = cables.find((cable) => cable.toNodeId === odp.id)

      if (clients.length === 1) {
        const client = offlineClients[0]
        const dropCable = cables.find((cable) => cable.toNodeId === client.id)

        alerts.push({
          severity: 'LOW',
          title: 'Client offline individual',
          message: `${client.name} offline. Kemungkinan gangguan di router/ONT/drop wire client.`,
          suspectedNodeId: client.id,
          suspectedNodeName: client.name,
          suspectedCableId: dropCable?.id || null,
          suspectedCableName: dropCable?.name || null,
          affectedClients: 1,
          totalClients: clients.length,
          offlineClientNames: [client.name],
        })

        continue
      }

      if (clients.length >= 2 && offlineClients.length === clients.length) {
        alerts.push({
          severity: 'HIGH',
          title: 'Kemungkinan gangguan ODP / jalur distribution',
          message: `Semua client di bawah ${odp.name} sedang offline.`,
          suspectedNodeId: odp.id,
          suspectedNodeName: odp.name,
          suspectedCableId: cableToOdp?.id || null,
          suspectedCableName: cableToOdp?.name || null,
          affectedClients: offlineClients.length,
          totalClients: clients.length,
          offlineClientNames: offlineClients.map((client) => client.name),
        })

        continue
      }

      if (clients.length >= 3 && offlineClients.length / clients.length >= 0.5) {
        alerts.push({
          severity: 'MEDIUM',
          title: 'Sebagian besar client dalam ODP offline',
          message: `${offlineClients.length} dari ${clients.length} client di bawah ${odp.name} sedang offline.`,
          suspectedNodeId: odp.id,
          suspectedNodeName: odp.name,
          suspectedCableId: cableToOdp?.id || null,
          suspectedCableName: cableToOdp?.name || null,
          affectedClients: offlineClients.length,
          totalClients: clients.length,
          offlineClientNames: offlineClients.map((client) => client.name),
        })

        continue
      }

      for (const client of offlineClients) {
        const dropCable = cables.find((cable) => cable.toNodeId === client.id)

        alerts.push({
          severity: 'LOW',
          title: 'Client offline individual',
          message: `${client.name} offline. Kemungkinan gangguan di router/ONT/drop wire client.`,
          suspectedNodeId: client.id,
          suspectedNodeName: client.name,
          suspectedCableId: dropCable?.id || null,
          suspectedCableName: dropCable?.name || null,
          affectedClients: 1,
          totalClients: clients.length,
          offlineClientNames: [client.name],
        })
      }
    }

    res.json({
      success: true,
      alerts,
      totalAlerts: alerts.length,
    })
  } catch (error) {
    console.error(error)

    res.status(500).json({
      success: false,
      message: 'Gagal menganalisa gangguan.',
    })
  }
})

app.post('/api/topology/recalculate-status', requireAdmin, async (req, res) => {
  try {
    const result = await recalculateAllOdpStatuses()

    res.json({
      success: true,
      message: 'Status topologi berhasil dihitung ulang.',
      updatedNodes: result.updatedNodes,
      updatedCables: result.updatedCables,
    })
  } catch (error) {
    console.error(error)

    res.status(500).json({
      success: false,
      message: 'Gagal menghitung ulang status topologi.',
    })
  }
})

io.on('connection', async (socket) => {
  console.log('Frontend connected:', socket.id)

  const nodes = await prisma.node.findMany({
    orderBy: {
      id: 'asc',
    },
  })

  const cables = await prisma.cable.findMany({
    orderBy: {
      id: 'asc',
    },
  })

  socket.emit('network-initial-data', {
    nodes,
    cables,
  })

  socket.on('disconnect', () => {
    console.log('Frontend disconnected:', socket.id)
  })
})

httpServer.listen(PORT, HOST, () => {
  console.log(`Backend running on http://${HOST}:${PORT}`)
  startPingMonitor(io)
  startPppoeMonitor(io)
  startOltMonitor(io)
})

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

async function recalculateAllOdpStatuses(): Promise<{
  updatedNodes: Node[]
  updatedCables: Cable[]
}> {
  const nodes = await prisma.node.findMany({
    orderBy: {
      id: 'asc',
    },
  })

  const odps = nodes.filter((node) => node.type === 'ODP')
  const updatedNodes: Node[] = []
  const updatedCables: Cable[] = []

  for (const odp of odps) {
    const clients = nodes.filter(
      (node) => node.type === 'CLIENT' && node.parentId === odp.id,
    )

    const offlineClients = clients.filter(
      (client) => client.status === 'OFFLINE',
    )

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

    const updatedOdp = await prisma.node.update({
      where: {
        id: odp.id,
      },
      data: {
        status: odpStatus,
      },
    })

    updatedNodes.push(updatedOdp)
    io.emit('node-status-updated', updatedOdp)

    const cableToOdp = await prisma.cable.findFirst({
      where: {
        toNodeId: odp.id,
      },
    })

    if (cableToOdp) {
      const updatedCable = await prisma.cable.update({
        where: {
          id: cableToOdp.id,
        },
        data: {
          status: cableToOdpStatus,
        },
      })

      updatedCables.push(updatedCable)
      io.emit('cable-status-updated', updatedCable)
    }
  }

  return {
    updatedNodes,
    updatedCables,
  }
}

type MonitoringLogInput = {
  nodeId?: string | null
  eventType: MonitoringLogEventType
  oldStatus?: NodeStatus | null
  newStatus?: NodeStatus | null
  title?: string | null
  message: string
  metadata?: unknown
}

function parseNetworkDeviceType(value: unknown): NetworkDeviceType | null {
  if (!value) return null

  return allowedNetworkDeviceTypes.includes(value as NetworkDeviceType)
    ? (value as NetworkDeviceType)
    : null
}

function getDefaultNetworkDevicePort(type: NetworkDeviceType) {
  if (type === 'MIKROTIK') return 8728
  return 161
}

function encryptSecret(value: string | null): string | null {
  if (!value) return null

  const key = crypto.createHash('sha256').update(JWT_SECRET).digest()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([
    cipher.update(value, 'utf8'),
    cipher.final(),
  ])
  const authTag = cipher.getAuthTag()

  return [
    'aes256gcm',
    iv.toString('base64url'),
    authTag.toString('base64url'),
    encrypted.toString('base64url'),
  ].join('$')
}

function decryptSecret(value: string | null): string {
  if (!value) return ''

  if (!value.startsWith('aes256gcm$')) {
    return value
  }

  try {
    const [, ivRaw, authTagRaw, encryptedRaw] = value.split('$')

    if (!ivRaw || !authTagRaw || !encryptedRaw) {
      return ''
    }

    const key = crypto.createHash('sha256').update(JWT_SECRET).digest()
    const iv = Buffer.from(ivRaw, 'base64url')
    const authTag = Buffer.from(authTagRaw, 'base64url')
    const encrypted = Buffer.from(encryptedRaw, 'base64url')

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(authTag)

    return Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]).toString('utf8')
  } catch (error) {
    console.error('Gagal decrypt password:', error)
    return ''
  }
}

function sanitizeNetworkDevice(device: NetworkDevice) {
  return {
    id: device.id,
    name: device.name,
    type: device.type,
    host: device.host,
    port: device.port,
    username: device.username,
    hasPassword: Boolean(device.passwordEncrypted),
    brand: device.brand,
    model: device.model,
    notes: device.notes,
    isActive: device.isActive,
    connectionStatus: device.connectionStatus,
    lastConnectedAt: device.lastConnectedAt,
    lastConnectionMessage: device.lastConnectionMessage,
    createdAt: device.createdAt,
    updatedAt: device.updatedAt,
  }
}

async function validateNodeMonitoringDevices(input: {
  monitoringMethod: MonitoringMethod
  mikrotikDeviceId?: string | null
  oltDeviceId?: string | null
}) {
  if (input.mikrotikDeviceId) {
    const mikrotikDevice = await prisma.networkDevice.findUnique({
      where: { id: input.mikrotikDeviceId },
    })

    if (!mikrotikDevice || mikrotikDevice.type !== 'MIKROTIK') {
      const error = new Error('Perangkat MikroTik tidak ditemukan atau tipe perangkat tidak sesuai.')
      ;(error as Error & { statusCode?: number }).statusCode = 400
      throw error
    }
  }

  if (input.oltDeviceId) {
    const oltDevice = await prisma.networkDevice.findUnique({
      where: { id: input.oltDeviceId },
    })

    if (!oltDevice || oltDevice.type !== 'OLT') {
      const error = new Error('Perangkat OLT tidak ditemukan atau tipe perangkat tidak sesuai.')
      ;(error as Error & { statusCode?: number }).statusCode = 400
      throw error
    }
  }

  if (input.monitoringMethod === 'PPPOE' && !input.mikrotikDeviceId) {
    const error = new Error('Mode PPPoE wajib memilih perangkat MikroTik.')
    ;(error as Error & { statusCode?: number }).statusCode = 400
    throw error
  }

  if (input.monitoringMethod === 'OLT' && !input.oltDeviceId) {
    const error = new Error('Mode OLT wajib memilih perangkat OLT.')
    ;(error as Error & { statusCode?: number }).statusCode = 400
    throw error
  }
}

function normalizeOptionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null

  const text = String(value).trim()
  return text.length > 0 ? text : null
}

function parseOptionalNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null

  const numberValue = Number(value)
  return Number.isNaN(numberValue) ? null : numberValue
}

function parseOptionalDate(value: unknown): Date | null {
  if (value === undefined || value === null || value === '') return null

  const dateValue = new Date(String(value))
  return Number.isNaN(dateValue.getTime()) ? null : dateValue
}

function valueOrExistingString(
  value: unknown,
  existingValue: string | null,
): string | null {
  if (value === undefined) return existingValue
  return normalizeOptionalString(value)
}

function valueOrExistingNumber(
  value: unknown,
  existingValue: number | null,
): number | null {
  if (value === undefined) return existingValue
  return parseOptionalNumber(value)
}

function valueOrExistingDate(
  value: unknown,
  existingValue: Date | null,
): Date | null {
  if (value === undefined) return existingValue
  return parseOptionalDate(value)
}

function parseInstallationStatus(value: unknown): InstallationStatus | null {
  if (!value) return null

  return allowedInstallationStatuses.includes(value as InstallationStatus)
    ? (value as InstallationStatus)
    : null
}

function parseOnuStatus(value: unknown): OnuStatus | null {
  if (!value) return null

  return allowedOnuStatuses.includes(value as OnuStatus)
    ? (value as OnuStatus)
    : null
}

function getMonitoringLogEventType(status: NodeStatus): MonitoringLogEventType {
  if (status === 'ONLINE') return 'NODE_ONLINE'
  if (status === 'OFFLINE') return 'NODE_OFFLINE'
  if (status === 'WARNING') return 'NODE_WARNING'
  return 'NODE_UNKNOWN'
}

async function createMonitoringLog(input: MonitoringLogInput) {
  try {
    const log = await prisma.monitoringLog.create({
      data: {
        nodeId: input.nodeId || null,
        eventType: input.eventType,
        oldStatus: input.oldStatus || null,
        newStatus: input.newStatus || null,
        title: input.title || null,
        message: input.message,
        metadata:
          input.metadata === undefined || input.metadata === null
            ? undefined
            : (input.metadata as Prisma.InputJsonValue),
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

    return log
  } catch (error) {
    console.error('Gagal membuat monitoring log:', error)
    return null
  }
}

function sanitizeUser(user: {
  id: string
  name: string
  username: string
  role: UserRole
  access: UserAccess
  isActive: boolean
  createdAt?: Date
  updatedAt?: Date
}) {
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    role: user.role,
    access: user.access,
    isActive: user.isActive,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  }
}

function hashPassword(password: string) {
  const salt = crypto.randomBytes(16).toString('hex')
  const iterations = 100_000
  const hash = crypto
    .pbkdf2Sync(password, salt, iterations, 64, 'sha512')
    .toString('hex')

  return `pbkdf2$${iterations}$${salt}$${hash}`
}

function verifyPassword(password: string, storedHash: string) {
  const parts = storedHash.split('$')

  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false

  const iterations = Number(parts[1])
  const salt = parts[2]
  const originalHash = parts[3]

  if (!Number.isFinite(iterations) || !salt || !originalHash) return false

  const currentHash = crypto
    .pbkdf2Sync(password, salt, iterations, 64, 'sha512')
    .toString('hex')

  return crypto.timingSafeEqual(
    Buffer.from(currentHash, 'hex'),
    Buffer.from(originalHash, 'hex'),
  )
}

function base64UrlEncode(value: string) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

function base64UrlDecode(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    '=',
  )

  return Buffer.from(padded, 'base64').toString('utf8')
}

function createAuthToken(userId: string) {
  const payload: AuthTokenPayload = {
    userId,
    exp: Math.floor(Date.now() / 1000) + TOKEN_EXPIRES_IN_SECONDS,
  }

  const encodedPayload = base64UrlEncode(JSON.stringify(payload))
  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(encodedPayload)
    .digest('base64url')

  return `${encodedPayload}.${signature}`
}

function verifyAuthToken(token: string): AuthTokenPayload | null {
  const [encodedPayload, signature] = token.split('.')

  if (!encodedPayload || !signature) return null

  const expectedSignature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(encodedPayload)
    .digest('base64url')

  const signatureBuffer = Buffer.from(signature)
  const expectedSignatureBuffer = Buffer.from(expectedSignature)

  if (signatureBuffer.length !== expectedSignatureBuffer.length) return null

  const isValidSignature = crypto.timingSafeEqual(
    signatureBuffer,
    expectedSignatureBuffer,
  )

  if (!isValidSignature) return null

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload)) as AuthTokenPayload

    if (!payload.userId || !payload.exp) return null
    if (payload.exp < Math.floor(Date.now() / 1000)) return null

    return payload
  } catch {
    return null
  }
}

async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const authReq = req as AuthenticatedRequest
  const authorization = req.headers.authorization
  const token = authorization?.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : null

  if (!token) {
    res.status(401).json({
      success: false,
      message: 'Token login tidak ditemukan.',
    })
    return
  }

  const payload = verifyAuthToken(token)

  if (!payload) {
    res.status(401).json({
      success: false,
      message: 'Token login tidak valid atau sudah kedaluwarsa.',
    })
    return
  }

  const user = await prisma.user.findUnique({
    where: {
      id: payload.userId,
    },
  })

  if (!user || !user.isActive) {
    res.status(403).json({
      success: false,
      message: 'User tidak aktif atau tidak ditemukan.',
    })
    return
  }

  authReq.authUser = sanitizeUser(user)
  next()
}

async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  await requireAuth(req, res, () => {
    const authReq = req as AuthenticatedRequest

    if (authReq.authUser?.role !== 'ADMIN') {
      res.status(403).json({
        success: false,
        message: 'Akses hanya untuk admin.',
      })
      return
    }

    next()
  })
}

async function requireEditAccess(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  await requireAuth(req, res, () => {
    const authReq = req as AuthenticatedRequest
    const user = authReq.authUser

    if (!user) {
      res.status(401).json({
        success: false,
        message: 'User login tidak ditemukan.',
      })
      return
    }

    if (user.role === 'ADMIN') {
      next()
      return
    }

    if (user.access !== 'EDIT') {
      res.status(403).json({
        success: false,
        message: 'Akun VIEW hanya boleh melihat data, tidak boleh menambah atau mengubah data.',
      })
      return
    }

    next()
  })
}

function parseUserRole(value: unknown): UserRole | null {
  if (!value) return null

  return allowedUserRoles.includes(value as UserRole) ? (value as UserRole) : null
}

function parseUserAccess(value: unknown): UserAccess | null {
  if (!value) return null

  return allowedUserAccess.includes(value as UserAccess)
    ? (value as UserAccess)
    : null
}

function parseCableRouteCoordinates(input: unknown): [number, number][] | null {
  if (!Array.isArray(input) || input.length < 2) return null

  const coordinates: [number, number][] = []

  for (const point of input) {
    if (!Array.isArray(point) || point.length < 2) return null

    const latitude = Number(point[0])
    const longitude = Number(point[1])

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      return null
    }

    coordinates.push([Number(latitude.toFixed(7)), Number(longitude.toFixed(7))])
  }

  return coordinates
}

function getAutomaticCableType(
  nodeType: string,
  parentType: string,
): 'BACKBONE' | 'DISTRIBUTION' | 'DROP_WIRE' | null {
  if (nodeType === 'CLIENT' && parentType === 'ODP') {
    return 'DROP_WIRE'
  }

  if (nodeType === 'ODP' && parentType === 'POLE') {
    return 'DISTRIBUTION'
  }

  if (nodeType === 'ODP' && parentType === 'OLT') {
    return 'DISTRIBUTION'
  }

  if (nodeType === 'POLE' && parentType === 'OLT') {
    return 'BACKBONE'
  }

  if (nodeType === 'POLE' && parentType === 'POLE') {
    return 'DISTRIBUTION'
  }

  return null
}

function getCablePrefix(cableType: 'BACKBONE' | 'DISTRIBUTION' | 'DROP_WIRE') {
  if (cableType === 'BACKBONE') return 'backbone'
  if (cableType === 'DISTRIBUTION') return 'distribution'
  return 'drop'
}

function getCableName(cableType: 'BACKBONE' | 'DISTRIBUTION' | 'DROP_WIRE') {
  if (cableType === 'BACKBONE') return 'Backbone'
  if (cableType === 'DISTRIBUTION') return 'Distribution'
  return 'Drop Wire'
}