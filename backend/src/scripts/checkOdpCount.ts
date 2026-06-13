import 'dotenv/config'
import { prisma } from '../prisma'

async function main() {
  const totalOdp = await prisma.node.count({
    where: {
      type: 'ODP',
    },
  })

  const lastOdps = await prisma.node.findMany({
    where: {
      type: 'ODP',
    },
    orderBy: {
      id: 'desc',
    },
    take: 10,
  })

  console.log('Total ODP:', totalOdp)
  console.log('10 ODP terakhir:')

  for (const odp of lastOdps) {
    console.log(`${odp.id} | ${odp.name} | ${odp.latitude}, ${odp.longitude}`)
  }
}

main()
  .catch((error) => {
    console.error(error)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })