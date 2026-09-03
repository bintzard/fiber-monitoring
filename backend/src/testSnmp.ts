import { testOltConnection } from './olt/zteC320'
import dotenv from 'dotenv'

dotenv.config()

async function main() {
  console.log('Memulai pengujian SNMP ke OLT...')
  try {
    const result = await testOltConnection()
    console.log('--- HASIL TEST SNMP ---')
    console.log('Status :', result.message)
    console.log('Host   :', result.host)
    console.log('SysName:', result.sysName)
    console.log('Output :', result.output)
  } catch (error: any) {
    console.error('--- GAGAL KONEKSI SNMP ---')
    console.error('Pesan Error:', error.message || error)
  }
}

main()