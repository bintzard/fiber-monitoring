import 'dotenv/config'
import { RouterOSAPI } from '@fibercom/routeros-api'

async function main() {
  const host = process.env.MIKROTIK_HOST
  const port = Number(process.env.MIKROTIK_PORT || 8728)
  const user = process.env.MIKROTIK_USER
  const password = process.env.MIKROTIK_PASSWORD

  console.log('MikroTik config:')
  console.log({
    host,
    port,
    user,
    password: password ? '********' : undefined,
  })

  if (!host || !user || !password) {
    throw new Error(
      'MIKROTIK_HOST, MIKROTIK_USER, dan MIKROTIK_PASSWORD wajib diisi di file .env',
    )
  }

  const router = new RouterOSAPI({
    host,
    port,
    user,
    password,
    timeout: 5000,
  })

  try {
    await router.connect()

    console.log('Berhasil konek ke MikroTik.')

    const identity = await router.write('/system/identity/print')
    console.log('Identity:', identity)

    const pppActive = await router.write('/ppp/active/print')
    console.log('Total PPPoE active:', pppActive.length)
    console.log('Sample PPPoE active:', pppActive.slice(0, 5))
  } catch (error) {
    console.error('Gagal konek atau membaca data MikroTik:')
    console.error(error)
  } finally {
    router.close()
  }
}

main()