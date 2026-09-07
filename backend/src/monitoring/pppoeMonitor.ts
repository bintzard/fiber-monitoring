import { RouterOSAPI } from "@fibercom/routeros-api";
import type { Server } from "socket.io";
import crypto from "crypto";
import { prisma } from "../prisma";
import { checkZteC320Onu } from "../olt/zteC320";
import type {
  Cable,
  CableStatus,
  MonitoringLogEventType,
  NetworkDevice,
  Node,
  NodeStatus,
} from "../generated/prisma/client";

const PPPOE_INTERVAL_MS = Number(process.env.PPPOE_INTERVAL_MS || 30000);
const MIKROTIK_TIMEOUT_MS = Number(process.env.MIKROTIK_TIMEOUT_MS || 8000);

const mikrotikClients = new Map<string, RouterOSAPI>();
const mikrotikConnecting = new Map<string, Promise<RouterOSAPI>>();
let isPppoeCheckRunning = false;

export interface PppActiveUser {
  name?: string;
  address?: string;
  uptime?: string;
  service?: string;
  "caller-id"?: string;
  comment?: string;
}

type MikrotikDevice = NetworkDevice & {
  type: "MIKROTIK";
};

export function extractPonInterfaceFromUsername(username: string): string | null {
  const match = username.match(/(\d+\/\d+\/\d+:\d+)/);
  if (!match) return null;
  return `gpon-onu_${match[1]}`;
}

export async function detectClientPppoeAndOlt(input: {
  pppoeUsername: string;
  mikrotikDeviceId?: string;
  oltDeviceId?: string;
}) {
  const username = normalizeUsername(input.pppoeUsername);
  const detectedOnuInterface = extractPonInterfaceFromUsername(input.pppoeUsername);

  let mikrotikDevice: NetworkDevice | null = null;
  if (input.mikrotikDeviceId) {
    mikrotikDevice = await prisma.networkDevice.findUnique({
      where: { id: input.mikrotikDeviceId },
    });
  } else {
    mikrotikDevice = await prisma.networkDevice.findFirst({
      where: { type: "MIKROTIK", isActive: true },
    });
  }

  let pppoeUser: PppActiveUser | null = null;
  if (mikrotikDevice && validateMikrotikDevice(mikrotikDevice)) {
    try {
      const activeUsers = await getPppoeActiveUsers(mikrotikDevice);
      pppoeUser =
        activeUsers.find(
          (u) => u.name && normalizeUsername(u.name) === username,
        ) || null;
    } catch (err) {
      console.warn("[PPPOE] Gagal query MikroTik saat auto-detect:", err);
    }
  }

  let oltData: any = null;
  if (detectedOnuInterface) {
    let oltDevice: NetworkDevice | null = null;
    if (input.oltDeviceId) {
      oltDevice = await prisma.networkDevice.findUnique({
        where: { id: input.oltDeviceId },
      });
    } else {
      oltDevice = await prisma.networkDevice.findFirst({
        where: { type: "OLT", isActive: true },
      });
    }

    if (oltDevice) {
      const community = decryptSecret(oltDevice.passwordEncrypted) || "balen";
      oltData = await checkZteC320Onu(detectedOnuInterface, {
        host: oltDevice.host,
        port: oltDevice.port || 161,
        community,
      });
    }
  }

  const isOnline = Boolean(pppoeUser) || oltData?.onuStatus === "ONLINE";
  const status: NodeStatus = isOnline ? "ONLINE" : "OFFLINE";

  return {
    pppoeUsername: input.pppoeUsername,
    ipAddress: pppoeUser?.address || null,
    uptime: pppoeUser?.uptime || null,
    status,
    onuInterface: detectedOnuInterface,
    rxPower: oltData?.onuRxPower ?? null,
    onuStatus: oltData?.onuStatus || (pppoeUser ? "ONLINE" : "UNKNOWN"),
    mikrotikDeviceId: mikrotikDevice?.id || null,
  };
}

export function startPppoeMonitor(io: Server) {
  console.log(
    `PPPoE monitor started. Interval: ${PPPOE_INTERVAL_MS}ms. Multi MikroTik mode enabled.`,
  );

  runPppoeCheckSafely(io);

  setInterval(() => {
    runPppoeCheckSafely(io);
  }, PPPOE_INTERVAL_MS);
}

async function runPppoeCheckSafely(io: Server) {
  if (isPppoeCheckRunning) return;
  isPppoeCheckRunning = true;
  try {
    await runPppoeCheck(io);
  } finally {
    isPppoeCheckRunning = false;
  }
}

function timeoutPromise<T>(timeoutMs: number, message: string): Promise<T> {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
  });
}

function normalizeUsername(value: string) {
  return value.trim().toLowerCase();
}

function decryptSecret(value: string | null) {
  if (!value) return "";
  if (!value.startsWith("aes256gcm$")) return value;

  try {
    const [, ivRaw, authTagRaw, encryptedRaw] = value.split("$");
    if (!ivRaw || !authTagRaw || !encryptedRaw) return "";

    const jwtSecret =
      process.env.JWT_SECRET || "dev-secret-change-this-before-production";
    const key = crypto.createHash("sha256").update(jwtSecret).digest();

    const iv = Buffer.from(ivRaw, "base64url");
    const authTag = Buffer.from(authTagRaw, "base64url");
    const encrypted = Buffer.from(encryptedRaw, "base64url");

    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);

    return Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    console.error("[PPPOE] Gagal decrypt password perangkat:", error);
    return "";
  }
}

function getDevicePassword(device: NetworkDevice) {
  return decryptSecret(device.passwordEncrypted);
}

function validateMikrotikDevice(
  device: NetworkDevice,
): device is MikrotikDevice {
  return (
    device.type === "MIKROTIK" &&
    device.isActive &&
    Boolean(device.host) &&
    Boolean(device.port) &&
    Boolean(device.username) &&
    Boolean(getDevicePassword(device))
  );
}

async function connectMikrotik(device: MikrotikDevice): Promise<RouterOSAPI> {
  const existingClient = mikrotikClients.get(device.id);
  if (existingClient) return existingClient;

  const existingConnection = mikrotikConnecting.get(device.id);
  if (existingConnection) return existingConnection;

  const connectionPromise = (async () => {
    const router = new RouterOSAPI({
      host: device.host,
      port: device.port,
      user: device.username || "",
      password: getDevicePassword(device),
      timeout: MIKROTIK_TIMEOUT_MS,
    });

    await Promise.race([
      router.connect(),
      timeoutPromise(
        MIKROTIK_TIMEOUT_MS,
        `Timeout saat konek ke MikroTik ${device.name}.`,
      ),
    ]);

    mikrotikClients.set(device.id, router);

    await prisma.networkDevice.update({
      where: { id: device.id },
      data: {
        connectionStatus: "CONNECTED",
        lastConnectedAt: new Date(),
        lastConnectionMessage: `Terhubung ke ${device.host}:${device.port}`,
      },
    });

    return router;
  })();

  mikrotikConnecting.set(device.id, connectionPromise);

  try {
    return await connectionPromise;
  } finally {
    mikrotikConnecting.delete(device.id);
  }
}

function resetMikrotikConnection(deviceId: string, reason?: unknown) {
  if (reason) {
    const message = reason instanceof Error ? reason.message : String(reason);
    console.warn(`[PPPOE] Reset koneksi MikroTik ${deviceId}: ${message}`);
  }

  const client = mikrotikClients.get(deviceId);
  if (client) {
    try {
      client.close();
    } catch {}
  }
  mikrotikClients.delete(deviceId);
  mikrotikConnecting.delete(deviceId);
}

function resetAllMikrotikConnections(reason?: unknown) {
  for (const deviceId of mikrotikClients.keys()) {
    resetMikrotikConnection(deviceId, reason);
  }
}

async function markDeviceDisconnected(device: NetworkDevice, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  await prisma.networkDevice.update({
    where: { id: device.id },
    data: {
      connectionStatus: "ERROR",
      lastConnectionMessage: message,
    },
  });
}

async function readPppoeActiveUsersOnce(
  device: MikrotikDevice,
): Promise<PppActiveUser[]> {
  const router = await connectMikrotik(device);
  const pppActive = await Promise.race([
    router.write("/ppp/active/print"),
    timeoutPromise(
      MIKROTIK_TIMEOUT_MS,
      `Timeout saat membaca PPP active di ${device.name}.`,
    ),
  ]);
  return pppActive as PppActiveUser[];
}

async function getPppoeActiveUsers(
  device: MikrotikDevice,
): Promise<PppActiveUser[]> {
  try {
    return await readPppoeActiveUsersOnce(device);
  } catch (error) {
    resetMikrotikConnection(device.id, error);
    try {
      return await readPppoeActiveUsersOnce(device);
    } catch (secondError) {
      resetMikrotikConnection(device.id, secondError);
      await markDeviceDisconnected(device, secondError);
      throw secondError;
    }
  }
}

process.once("SIGINT", () => resetAllMikrotikConnections("Backend berhenti (SIGINT)."));
process.once("SIGTERM", () => resetAllMikrotikConnections("Backend berhenti (SIGTERM)."));

async function runPppoeCheck(io: Server) {
  try {
    const mikrotikDevices = await prisma.networkDevice.findMany({
      where: { type: "MIKROTIK", isActive: true },
      orderBy: { name: "asc" },
    });

    const validDevices = mikrotikDevices.filter(validateMikrotikDevice);
    if (validDevices.length === 0) return;

    const monitoredNodes = await prisma.node.findMany({
      where: {
        monitoringEnabled: true,
        monitoringMethod: { in: ["PPPOE", "OLT"] },
        pppoeUsername: { not: null },
      },
      orderBy: { id: "asc" },
    });

    if (monitoredNodes.length === 0) return;

    for (const device of validDevices) {
      const nodesForDevice = monitoredNodes.filter(
        (node) => !node.mikrotikDeviceId || node.mikrotikDeviceId === device.id,
      );

      if (nodesForDevice.length === 0) continue;

      let activeUsers: PppActiveUser[];
      try {
        activeUsers = await getPppoeActiveUsers(device);
      } catch (error) {
        console.error(`[PPPOE] Gagal membaca ${device.name}:`, error);
        await prisma.networkDevice.update({
          where: { id: device.id },
          data: {
            connectionStatus: "ERROR",
            lastConnectionMessage:
              error instanceof Error ? error.message : "Gagal konek ke MikroTik",
          },
        });
        continue;
      }

      const activeUsernameSet = new Set(
        activeUsers
          .map((user) => user.name)
          .filter((name): name is string => Boolean(name))
          .map((name) => normalizeUsername(name)),
      );

      for (const node of nodesForDevice) {
        if (!node.pppoeUsername) continue;

        const username = normalizeUsername(node.pppoeUsername);
        const isOnline = activeUsernameSet.has(username);
        const nextStatus: NodeStatus = isOnline ? "ONLINE" : "OFFLINE";

        const activeUser = activeUsers.find(
          (user) => user.name && normalizeUsername(user.name) === username,
        );

        const nextIpAddress = activeUser?.address || node.ipAddress;
        const autoOnuInterface =
          node.onuInterface || extractPonInterfaceFromUsername(node.pppoeUsername);

        const shouldUpdate =
          node.status !== nextStatus ||
          node.ipAddress !== nextIpAddress ||
          node.onuInterface !== autoOnuInterface;

        if (shouldUpdate) {
          const updatedNode = await updateNodeStatusFromPppoe(
            node.id,
            nextStatus,
            nextIpAddress || null,
            autoOnuInterface || null,
          );

          if (node.status !== updatedNode.status) {
            await createMonitoringLog(io, {
              nodeId: updatedNode.id,
              eventType: getMonitoringLogEventType(updatedNode.status),
              oldStatus: node.status,
              newStatus: updatedNode.status,
              title: getMonitoringLogTitle(updatedNode.status),
              message: `${updatedNode.name} berubah menjadi ${updatedNode.status} lewat monitoring PPPoE ${device.name}.`,
            });
          }

          const affectedCables = await updateCableStatusByNode(
            node.id,
            nextStatus,
          );

          const recalculatedTopology = await recalculateOdpStatusByClient(
            node.id,
          );

          io.emit("node-status-updated", updatedNode);

          affectedCables.forEach((cable) => {
            io.emit("cable-status-updated", cable);
          });

          recalculatedTopology.updatedNodes.forEach((updatedTopologyNode) => {
            io.emit("node-status-updated", updatedTopologyNode);
          });

          recalculatedTopology.updatedCables.forEach((updatedCable) => {
            io.emit("cable-status-updated", updatedCable);
          });
        } else {
          const checkedNode = await updateLastCheckedAt(node.id, nextStatus);
          if (checkedNode) {
            io.emit("node-status-updated", checkedNode);
          }
        }
      }
    }
  } catch (error) {
    console.error("PPPOE MONITOR ERROR:", error);
  }
}

async function updateNodeStatusFromPppoe(
  nodeId: string,
  status: NodeStatus,
  ipAddress: string | null,
  onuInterface: string | null,
): Promise<Node> {
  const existingNode = await prisma.node.findUnique({
    where: { id: nodeId },
  });

  if (!existingNode) {
    throw new Error("Node tidak ditemukan saat update PPPoE status.");
  }

  const now = new Date();

  return prisma.node.update({
    where: { id: nodeId },
    data: {
      status,
      ipAddress,
      onuInterface: onuInterface || existingNode.onuInterface,
      latencyMs: null,
      lastCheckedAt: now,
      lastSeenAt: status === "ONLINE" ? now : existingNode.lastSeenAt,
      offlineSince:
        status === "OFFLINE" ? existingNode.offlineSince || now : null,
    },
  });
}

async function updateLastCheckedAt(
  nodeId: string,
  status: NodeStatus,
): Promise<Node | null> {
  const existingNode = await prisma.node.findUnique({
    where: { id: nodeId },
  });

  if (!existingNode) return null;

  const now = new Date();

  return prisma.node.update({
    where: { id: nodeId },
    data: {
      lastCheckedAt: now,
      lastSeenAt: status === "ONLINE" ? now : existingNode.lastSeenAt,
      offlineSince:
        status === "OFFLINE" ? existingNode.offlineSince || now : null,
    },
  });
}

function getMonitoringLogEventType(status: NodeStatus): MonitoringLogEventType {
  if (status === "ONLINE") return "NODE_ONLINE";
  if (status === "OFFLINE") return "NODE_OFFLINE";
  if (status === "WARNING") return "NODE_WARNING";
  return "NODE_UNKNOWN";
}

function getMonitoringLogTitle(status: NodeStatus) {
  if (status === "ONLINE") return "Client ONLINE kembali";
  if (status === "OFFLINE") return "Client OFFLINE";
  if (status === "WARNING") return "Client WARNING";
  return "Status client berubah";
}

type MonitoringLogPayload = {
  nodeId: string;
  eventType: MonitoringLogEventType;
  oldStatus: NodeStatus | null;
  newStatus: NodeStatus;
  title: string;
  message: string;
};

async function createMonitoringLog(io: Server, payload: MonitoringLogPayload) {
  try {
    const log = await prisma.monitoringLog.create({
      data: {
        nodeId: payload.nodeId,
        eventType: payload.eventType,
        oldStatus: payload.oldStatus,
        newStatus: payload.newStatus,
        title: payload.title,
        message: payload.message,
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
    });

    io.emit("monitoring-log-created", log);
  } catch (error) {
    console.error("Gagal membuat MonitoringLog PPPoE:", error);
  }
}

async function updateCableStatusByNode(
  nodeId: string,
  status: NodeStatus,
): Promise<Cable[]> {
  const affectedCables: Cable[] = [];

  const relatedCable = await prisma.cable.findFirst({
    where: { toNodeId: nodeId },
  });

  if (relatedCable) {
    const updatedRelatedCable = await prisma.cable.update({
      where: { id: relatedCable.id },
      data: {
        status: status === "OFFLINE" ? "BROKEN" : "NORMAL",
      },
    });

    affectedCables.push(updatedRelatedCable);
  }

  return affectedCables;
}

async function recalculateOdpStatusByClient(clientId: string): Promise<{
  updatedNodes: Node[];
  updatedCables: Cable[];
}> {
  const client = await prisma.node.findUnique({
    where: { id: clientId },
  });

  if (!client || client.type !== "CLIENT" || !client.parentId) {
    return { updatedNodes: [], updatedCables: [] };
  }

  const odp = await prisma.node.findUnique({
    where: { id: client.parentId },
  });

  if (!odp || odp.type !== "ODP") {
    return { updatedNodes: [], updatedCables: [] };
  }

  const clients = await prisma.node.findMany({
    where: { type: "CLIENT", parentId: odp.id },
  });

  const offlineClients = clients.filter((item) => item.status === "OFFLINE");

  let odpStatus: NodeStatus = "ONLINE";
  let cableToOdpStatus: CableStatus = "NORMAL";

  if (clients.length <= 1) {
    odpStatus = "ONLINE";
    cableToOdpStatus = "NORMAL";
  } else if (offlineClients.length === 0) {
    odpStatus = "ONLINE";
    cableToOdpStatus = "NORMAL";
  } else if (offlineClients.length < clients.length) {
    odpStatus = "WARNING";
    cableToOdpStatus = "NORMAL";
  } else {
    odpStatus = "OFFLINE";
    cableToOdpStatus = "AFFECTED";
  }

  const updatedNodes: Node[] = [];
  const updatedCables: Cable[] = [];

  const updatedOdp = await prisma.node.update({
    where: { id: odp.id },
    data: { status: odpStatus },
  });

  updatedNodes.push(updatedOdp);

  const cableToOdp = await prisma.cable.findFirst({
    where: { toNodeId: odp.id },
  });

  if (cableToOdp) {
    const updatedCableToOdp = await prisma.cable.update({
      where: { id: cableToOdp.id },
      data: { status: cableToOdpStatus },
    });

    updatedCables.push(updatedCableToOdp);
  }

  return { updatedNodes, updatedCables };
}