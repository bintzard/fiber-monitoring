import 'dotenv/config'
import { prisma } from '../prisma'

async function main() {
  console.log('Mulai cleanup data percobaan...')

  const clients = await prisma.node.findMany({
    where: {
      type: {
        in: ['CLIENT', 'ROUTER'],
      },
    },
    select: {
      id: true,
      name: true,
      type: true,
    },
  })

  const allCables = await prisma.cable.findMany({
    select: {
      id: true,
      name: true,
      type: true,
    },
  })

  console.log('Data yang akan dihapus:')
  console.log(`Client/Router : ${clients.length}`)
  console.log(`Cable         : ${allCables.length}`)

  console.log('\nDaftar Client/Router:')
  for (const node of clients) {
    console.log(`- ${node.id} | ${node.name} | ${node.type}`)
  }

  console.log('\nDaftar Cable:')
  for (const cable of allCables) {
    console.log(`- ${cable.id} | ${cable.name} | ${cable.type}`)
  }

  console.log('\nMenghapus semua cable...')
  const deletedCables = await prisma.cable.deleteMany({})

  console.log('Menghapus semua CLIENT dan ROUTER...')
  const deletedNodes = await prisma.node.deleteMany({
    where: {
      type: {
        in: ['CLIENT', 'ROUTER'],
      },
    },
  })

  console.log('--------------------------------')
  console.log('Cleanup selesai.')
  console.log(`Cable terhapus        : ${deletedCables.count}`)
  console.log(`Client/Router terhapus: ${deletedNodes.count}`)
  console.log('ODP dan OLT tetap disimpan.')
}

main()
  .catch((error) => {
    console.error('CLEANUP ERROR:')
    console.error(error)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })