import { RouterOSAPI } from "@fibercom/routeros-api";
import type { Server } from "socket.io";
import { prisma } from "../prisma";
import type {
  Cable,
  CableStatus,
  MonitoringLogEventType,
  Node,
  NodeStatus,
} from "../generated/prisma/client";

const PPPOE_INTERVAL_MS = Number(process.env.PPPOE_INTERVAL_MS || 30000);
const MIKROTIK_TIMEOUT_MS = Number(process.env.MIKROTIK_TIMEOUT_MS || 8000);

let mikrotikClient: RouterOSAPI | null = null;
let mikrotikConnecting: Promise<RouterOSAPI> | null = null;
let isPppoeCheckRunning = false;

interface PppActiveUser {
  name?: string;
  address?: string;
  uptime?: string;
  service?: string;
  "caller-id"?: string;
  comment?: string;
}

export function startPppoeMonitor(io: Server) {
  console.log(
    `PPPoE monitor started. Interval: ${PPPOE_INTERVAL_MS}ms. MikroTik API persistent connection enabled.`,
  );

  runPppoeCheckSafely(io);

  setInterval(() => {
    runPppoeCheckSafely(io);
  }, PPPOE_INTERVAL_MS);
}

async function runPppoeCheckSafely(io: Server) {
  if (isPppoeCheckRunning) {
    console.log("[PPPOE] Check sebelumnya masih berjalan, skip polling ini.");
    return;
  }

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

async function getMikrotikConfig() {
  const host = process.env.MIKROTIK_HOST;
  const port = Number(process.env.MIKROTIK_PORT || 8728);
  const user = process.env.MIKROTIK_USER;
  const password = process.env.MIKROTIK_PASSWORD;

  if (!host || !user || !password) {
    throw new Error(
      "MIKROTIK_HOST, MIKROTIK_USER, dan MIKROTIK_PASSWORD wajib diisi di file .env",
    );
  }

  return {
    host,
    port,
    user,
    password,
  };
}

async function connectMikrotik(): Promise<RouterOSAPI> {
  if (mikrotikClient) {
    return mikrotikClient;
  }

  if (mikrotikConnecting) {
    return mikrotikConnecting;
  }

  mikrotikConnecting = (async () => {
    const config = await getMikrotikConfig();

    const router = new RouterOSAPI({
      ...config,
      timeout: MIKROTIK_TIMEOUT_MS,
    });

    await Promise.race([
      router.connect(),
      timeoutPromise(
        MIKROTIK_TIMEOUT_MS,
        "Timeout saat konek ke MikroTik API.",
      ),
    ]);

    mikrotikClient = router;
    console.log(
      `[PPPOE] MikroTik API connected: ${config.host}:${config.port}`,
    );

    return router;
  })();

  try {
    return await mikrotikConnecting;
  } finally {
    mikrotikConnecting = null;
  }
}

function resetMikrotikConnection(reason?: unknown) {
  if (reason) {
    const message = reason instanceof Error ? reason.message : String(reason);
    console.warn(`[PPPOE] Reset koneksi MikroTik API: ${message}`);
  }

  if (mikrotikClient) {
    try {
      mikrotikClient.close();
    } catch {
      // abaikan error close
    }
  }

  mikrotikClient = null;
  mikrotikConnecting = null;
}

async function readPppoeActiveUsersOnce(): Promise<PppActiveUser[]> {
  const router = await connectMikrotik();

  const pppActive = await Promise.race([
    router.write("/ppp/active/print"),
    timeoutPromise(MIKROTIK_TIMEOUT_MS, "Timeout saat membaca PPP active."),
  ]);

  return pppActive as PppActiveUser[];
}

async function getPppoeActiveUsers(): Promise<PppActiveUser[]> {
  try {
    return await readPppoeActiveUsersOnce();
  } catch (error) {
    resetMikrotikConnection(error);

    // Coba sekali lagi setelah reconnect. Ini berguna kalau koneksi lama stale/putus diam-diam.
    return await readPppoeActiveUsersOnce();
  }
}

process.once("SIGINT", () => {
  resetMikrotikConnection("Backend berhenti (SIGINT).");
});

process.once("SIGTERM", () => {
  resetMikrotikConnection("Backend berhenti (SIGTERM).");
});

async function runPppoeCheck(io: Server) {
  try {
    const monitoredNodes = await prisma.node.findMany({
      where: {
        monitoringEnabled: true,
        monitoringMethod: "PPPOE",
        pppoeUsername: {
          not: null,
        },
      },
      orderBy: {
        id: "asc",
      },
    });

    if (monitoredNodes.length === 0) {
      return;
    }

    const activeUsers = await getPppoeActiveUsers();

    const activeUsernameSet = new Set(
      activeUsers
        .map((user) => user.name)
        .filter((name): name is string => Boolean(name))
        .map((name) => normalizeUsername(name)),
    );

    for (const node of monitoredNodes) {
      if (!node.pppoeUsername) continue;

      const username = normalizeUsername(node.pppoeUsername);
      const isOnline = activeUsernameSet.has(username);
      const nextStatus: NodeStatus = isOnline ? "ONLINE" : "OFFLINE";

      const activeUser = activeUsers.find(
        (user) => user.name && normalizeUsername(user.name) === username,
      );

      const nextIpAddress = activeUser?.address || node.ipAddress;

      const shouldUpdate =
        node.status !== nextStatus ||
        node.ipAddress !== nextIpAddress ||
        node.latencyMs !== null;

      if (shouldUpdate) {
        const updatedNode = await updateNodeStatusFromPppoe(
          node.id,
          nextStatus,
          nextIpAddress || null,
        );

        if (node.status !== updatedNode.status) {
          await createMonitoringLog(io, {
            nodeId: updatedNode.id,
            eventType: getMonitoringLogEventType(updatedNode.status),
            oldStatus: node.status,
            newStatus: updatedNode.status,
            title: getMonitoringLogTitle(updatedNode.status),
            message: `${updatedNode.name} berubah menjadi ${updatedNode.status} lewat monitoring PPPoE.`,
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

        console.log(
          `[PPPOE] ${node.name} (${node.pppoeUsername}) => ${nextStatus}`,
        );
      } else {
        const checkedNode = await updateLastCheckedAt(node.id, nextStatus);

        if (checkedNode) {
          io.emit("node-status-updated", checkedNode);
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
): Promise<Node> {
  const existingNode = await prisma.node.findUnique({
    where: {
      id: nodeId,
    },
  });

  if (!existingNode) {
    throw new Error("Node tidak ditemukan saat update PPPoE status.");
  }

  const now = new Date();

  return prisma.node.update({
    where: {
      id: nodeId,
    },
    data: {
      status,
      ipAddress,
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
    where: {
      id: nodeId,
    },
  });

  if (!existingNode) return null;

  const now = new Date();

  return prisma.node.update({
    where: {
      id: nodeId,
    },
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
    where: {
      toNodeId: nodeId,
    },
  });

  if (relatedCable) {
    const updatedRelatedCable = await prisma.cable.update({
      where: {
        id: relatedCable.id,
      },
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
    where: {
      id: clientId,
    },
  });

  if (!client || client.type !== "CLIENT" || !client.parentId) {
    return {
      updatedNodes: [],
      updatedCables: [],
    };
  }

  const odp = await prisma.node.findUnique({
    where: {
      id: client.parentId,
    },
  });

  if (!odp || odp.type !== "ODP") {
    return {
      updatedNodes: [],
      updatedCables: [],
    };
  }

  const clients = await prisma.node.findMany({
    where: {
      type: "CLIENT",
      parentId: odp.id,
    },
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
    where: {
      id: odp.id,
    },
    data: {
      status: odpStatus,
    },
  });

  updatedNodes.push(updatedOdp);

  const cableToOdp = await prisma.cable.findFirst({
    where: {
      toNodeId: odp.id,
    },
  });

  if (cableToOdp) {
    const updatedCableToOdp = await prisma.cable.update({
      where: {
        id: cableToOdp.id,
      },
      data: {
        status: cableToOdpStatus,
      },
    });

    updatedCables.push(updatedCableToOdp);
  }

  return {
    updatedNodes,
    updatedCables,
  };
}
