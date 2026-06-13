import 'dotenv/config'
import { prisma } from '../prisma'

async function main() {
  const oltNode = await prisma.node.findFirst({
    where: {
      name: 'OLT_Server_Balen',
    },
  })

  if (!oltNode) {
    console.log('OLT_Server_Balen tidak ditemukan.')
    console.log('Pastikan node OLT sudah ada dan namanya OLT_Server_Balen.')
    return
  }

  const fixedOlt = await prisma.node.update({
    where: {
      id: oltNode.id,
    },
    data: {
      name: 'OLT_Server_Balen',
      type: 'OLT',
      status: 'ONLINE',
      parentId: null,
      monitoringEnabled: false,
      monitoringMethod: 'MANUAL',
    },
  })

  console.log(`OLT dipakai: ${fixedOlt.id} | ${fixedOlt.name} | ${fixedOlt.type}`)

  const totalOdpBefore = await prisma.node.count({
    where: {
      type: 'ODP',
    },
  })

  console.log(`Total ODP ditemukan sebelum update: ${totalOdpBefore}`)

  const result = await prisma.node.updateMany({
    where: {
      type: 'ODP',
      id: {
        not: fixedOlt.id,
      },
    },
    data: {
      parentId: fixedOlt.id,
      monitoringEnabled: false,
      monitoringMethod: 'MANUAL',
    },
  })

  console.log('--------------------------------')
  console.log('Selesai menghubungkan ODP ke OLT.')
  console.log(`OLT ID              : ${fixedOlt.id}`)
  console.log(`ODP berhasil update : ${result.count}`)
  console.log('Catatan: script ini tidak membuat garis kabel.')
}

main()
  .catch((error) => {
    console.error('LINK ODP TO OLT ERROR:')
    console.error(error)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })