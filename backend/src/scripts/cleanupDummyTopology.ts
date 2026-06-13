import 'dotenv/config'
import { prisma } from '../prisma'

async function main() {
  console.log('Mulai cleanup dummy topology...')

  const dummyNodes = await prisma.node.findMany({
    where: {
      OR: [
        {
          type: 'POLE',
        },
        {
          id: {
            in: ['odp-1', 'odp-0002'],
          },
        },
        {
          name: {
            in: ['ODP FAT-01', 'ODP2'],
          },
        },
      ],
    },
    select: {
      id: true,
      name: true,
      type: true,
    },
  })

  console.log('Node dummy yang akan dihapus:')

  for (const node of dummyNodes) {
    console.log(`- ${node.id} | ${node.name} | ${node.type}`)
  }

  const dummyNodeIds = dummyNodes.map((node) => node.id)

  if (dummyNodeIds.length === 0) {
    console.log('Tidak ada dummy node yang ditemukan.')
    return
  }

  console.log('\nMenghapus cable yang terhubung ke dummy node...')

  const deletedCables = await prisma.cable.deleteMany({
    where: {
      OR: [
        {
          fromNodeId: {
            in: dummyNodeIds,
          },
        },
        {
          toNodeId: {
            in: dummyNodeIds,
          },
        },
      ],
    },
  })

  console.log('Menghapus dummy node...')

  const deletedNodes = await prisma.node.deleteMany({
    where: {
      id: {
        in: dummyNodeIds,
      },
    },
  })

  console.log('--------------------------------')
  console.log('Cleanup dummy topology selesai.')
  console.log(`Cable terhapus: ${deletedCables.count}`)
  console.log(`Node terhapus : ${deletedNodes.count}`)
}

main()
  .catch((error) => {
    console.error('CLEANUP DUMMY TOPOLOGY ERROR:')
    console.error(error)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })