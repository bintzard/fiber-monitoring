import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import { XMLParser } from 'fast-xml-parser'
import { prisma } from '../prisma'

interface ParsedPlacemark {
  name: string
  latitude: number
  longitude: number
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}

function textValue(value: unknown): string {
  if (value === null || value === undefined) return ''

  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number') return String(value)

  if (typeof value === 'object') {
    const objectValue = value as Record<string, unknown>

    if (typeof objectValue['#text'] === 'string') {
      return objectValue['#text'].trim()
    }
  }

  return ''
}

function collectPlacemarks(source: unknown): unknown[] {
  const results: unknown[] = []

  function walk(value: unknown) {
    if (!value || typeof value !== 'object') return

    if (Array.isArray(value)) {
      value.forEach((item) => walk(item))
      return
    }

    const objectValue = value as Record<string, unknown>

    if (objectValue.Placemark) {
      results.push(...toArray(objectValue.Placemark))
    }

    Object.values(objectValue).forEach((child) => walk(child))
  }

  walk(source)

  return results
}

function parseCoordinate(coordinateText: string) {
  const firstCoordinate = coordinateText.trim().split(/\s+/)[0]

  if (!firstCoordinate) return null

  const [longitudeText, latitudeText] = firstCoordinate.split(',')

  const longitude = Number(longitudeText)
  const latitude = Number(latitudeText)

  if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
    return null
  }

  return {
    latitude,
    longitude,
  }
}

function extractPointPlacemark(placemark: unknown): ParsedPlacemark | null {
  if (!placemark || typeof placemark !== 'object') return null

  const objectValue = placemark as Record<string, unknown>

  const name = textValue(objectValue.name) || 'ODP Tanpa Nama'

  const point = objectValue.Point as Record<string, unknown> | undefined

  if (!point) {
    return null
  }

  const coordinateText = textValue(point.coordinates)

  if (!coordinateText) {
    return null
  }

  const coordinate = parseCoordinate(coordinateText)

  if (!coordinate) {
    return null
  }

  return {
    name,
    latitude: coordinate.latitude,
    longitude: coordinate.longitude,
  }
}

async function generateNextOdpId() {
  const existingOdps = await prisma.node.findMany({
    where: {
      id: {
        startsWith: 'odp-',
      },
    },
    select: {
      id: true,
    },
  })

  let maxNumber = 0

  for (const odp of existingOdps) {
    const numberText = odp.id.replace('odp-', '')
    const numberValue = Number(numberText)

    if (!Number.isNaN(numberValue) && numberValue > maxNumber) {
      maxNumber = numberValue
    }
  }

  const nextNumber = maxNumber + 1

  return `odp-${String(nextNumber).padStart(4, '0')}`
}

async function importOdps(filePath: string) {
  const absolutePath = path.resolve(filePath)

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`File tidak ditemukan: ${absolutePath}`)
  }

  const kmlContent = fs.readFileSync(absolutePath, 'utf-8')

  const parser = new XMLParser({
    ignoreAttributes: false,
    trimValues: true,
  })

  const parsedKml = parser.parse(kmlContent)
  const rawPlacemarks = collectPlacemarks(parsedKml)

  const pointPlacemarks = rawPlacemarks
    .map((placemark) => extractPointPlacemark(placemark))
    .filter((placemark): placemark is ParsedPlacemark => Boolean(placemark))

  console.log(`Total Placemark terbaca: ${rawPlacemarks.length}`)
  console.log(`Total Point valid: ${pointPlacemarks.length}`)

  let insertedCount = 0
  let skippedCount = 0

  for (const placemark of pointPlacemarks) {
    const existingNode = await prisma.node.findFirst({
      where: {
        name: placemark.name,
        type: 'ODP',
        latitude: placemark.latitude,
        longitude: placemark.longitude,
      },
    })

    if (existingNode) {
      skippedCount += 1
      console.log(`SKIP: ${placemark.name} sudah ada`)
      continue
    }

    const id = await generateNextOdpId()

    const newNode = await prisma.node.create({
      data: {
        id,
        name: placemark.name,
        type: 'ODP',
        ipAddress: null,
        latitude: placemark.latitude,
        longitude: placemark.longitude,
        status: 'UNKNOWN',
        rxPower: null,
        parentId: null,

        pppoeUsername: null,
        monitoringEnabled: false,
        monitoringMethod: 'MANUAL',
        lastCheckedAt: null,
        lastSeenAt: null,
        offlineSince: null,
        latencyMs: null,
      },
    })

    insertedCount += 1

    console.log(
      `INSERT: ${newNode.id} | ${newNode.name} | ${newNode.latitude}, ${newNode.longitude}`,
    )
  }

  console.log('--------------------------------')
  console.log(`Import selesai.`)
  console.log(`Berhasil insert : ${insertedCount}`)
  console.log(`Dilewati        : ${skippedCount}`)
}

async function main() {
  const filePath = process.argv[2]

  if (!filePath) {
    console.log('Gunakan command:')
    console.log('npx tsx src/scripts/importKmlOdps.ts imports/olt-server-balen.kml')
    process.exit(1)
  }

  try {
    await importOdps(filePath)
  } catch (error) {
    console.error('IMPORT KML ERROR:')
    console.error(error)
  } finally {
    await prisma.$disconnect()
  }
}

main()