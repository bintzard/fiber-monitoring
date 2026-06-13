import 'dotenv/config'
import { prisma } from '../prisma'

async function main() {
  const olt = await prisma.node.findFirst({
    where: {
      name: 'OLT_Server_Balen',
    },
  })

  if (!olt) {
    console.log('OLT_Server_Balen tidak ditemukan.')
    return
  }

  const totalChildren = await prisma.node.count({
    where: {
      parentId: olt.id,
    },
  })

  const sampleChildren = await prisma.node.findMany({
    where: {
      parentId: olt.id,
    },
    orderBy: {
      id: 'asc',
    },
    take: 10,
  })

  console.log(`OLT: ${olt.id} | ${olt.name}`)
  console.log(`Total ODP terhubung: ${totalChildren}`)
  console.log('Contoh ODP:')

  for (const node of sampleChildren) {
    console.log(`${node.id} | ${node.name} | parentId: ${node.parentId}`)
  }
}

main()
  .catch((error) => console.error(error))
  .finally(async () => {
    await prisma.$disconnect()
  })