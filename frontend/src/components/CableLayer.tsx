import { useEffect, useRef } from 'react'
import { useMap } from 'react-leaflet'
import L from 'leaflet'
import type { Cable, NetworkNode } from '../types/network'

interface CableLayerProps {
  cables: Cable[]
  nodeMap: Map<string, NetworkNode>
  visibleCableTypes: {
    BACKBONE: boolean
    DISTRIBUTION: boolean
    DROP_WIRE: boolean
  }
  selectedFaultAlertCableId?: string | null
  cableAnimationEnabled?: boolean
  isAdmin?: boolean
  onEditRoute?: (cable: Cable) => void
  onDeleteCable?: (cableId: string) => void
}

function normalizeCoordinates(coords: Cable['coordinates']): [number, number][] {
  if (!Array.isArray(coords)) return []
  return coords
    .map((p) => [Number(p[0]), Number(p[1])] as [number, number])
    .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))
}

export default function CableLayer({
  cables,
  nodeMap,
  visibleCableTypes,
  selectedFaultAlertCableId,
  isAdmin = false,
  onEditRoute,
  onDeleteCable,
}: CableLayerProps) {
  const map = useMap()
  const layerRef = useRef<L.LayerGroup | null>(null)

  useEffect(() => {
    const layerGroup = L.layerGroup()
    layerRef.current = layerGroup

    const updateVisibility = () => {
      const zoom = map.getZoom()
      layerGroup.clearLayers()

      // Zoom < 15: sembunyikan semua kabel
      if (zoom < 15) return

      cables.forEach((cable) => {
        if (!visibleCableTypes[cable.type]) return

        // Zoom 15–16: sembunyikan Drop Wire
        if (zoom < 17 && cable.type === 'DROP_WIRE') return

        const coords = normalizeCoordinates(cable.coordinates)
        if (coords.length < 2) return

        let color = '#22c55e'
        let weight = 3
        let dashArray: string | undefined = undefined

        if (selectedFaultAlertCableId === cable.id) {
          color = '#0ea5e9'
          weight = 6
          dashArray = '10 6'
        } else if (cable.type === 'BACKBONE') {
          color = cable.status === 'BROKEN' ? '#ef4444' : '#2563eb'
          weight = 5
        } else if (cable.type === 'DISTRIBUTION') {
          color = cable.status === 'BROKEN' ? '#ef4444' : cable.status === 'AFFECTED' ? '#f59e0b' : '#22c55e'
          weight = 4
        } else if (cable.type === 'DROP_WIRE') {
          color = cable.status === 'BROKEN' ? '#ef4444' : cable.status === 'AFFECTED' ? '#f59e0b' : '#22c55e'
          weight = 2.5
        }

        const polyline = L.polyline(coords, {
          color,
          weight,
          dashArray,
          opacity: 0.85,
        })

        const fromNode = nodeMap.get(cable.fromNodeId)?.name || cable.fromNodeId
        const toNode = nodeMap.get(cable.toNodeId)?.name || cable.toNodeId

        // Buat konten popup secara aman
        const popupContainer = document.createElement('div')
        popupContainer.className = 'cable-popup'
        popupContainer.innerHTML = `
          <strong>${cable.name || 'Kabel'}</strong>
          <div class="popup-row"><span>Tipe</span><b>${cable.type}</b></div>
          <div class="popup-row"><span>Status</span><b>${cable.status}</b></div>
          <div class="popup-row"><span>Dari</span><b>${fromNode}</b></div>
          <div class="popup-row"><span>Ke</span><b>${toNode}</b></div>
        `

        if (isAdmin) {
          const editBtn = document.createElement('button')
          editBtn.type = 'button'
          editBtn.className = 'edit-node-button'
          editBtn.innerText = 'Edit Jalur'
          editBtn.onclick = () => onEditRoute?.(cable)
          popupContainer.appendChild(editBtn)

          const delBtn = document.createElement('button')
          delBtn.type = 'button'
          delBtn.className = 'delete-node-button'
          delBtn.innerText = 'Hapus Kabel'
          delBtn.onclick = () => onDeleteCable?.(cable.id)
          popupContainer.appendChild(delBtn)
        }

        polyline.bindPopup(popupContainer)
        layerGroup.addLayer(polyline)
      })
    }

    map.addLayer(layerGroup)
    updateVisibility()

    map.on('zoomend', updateVisibility)

    return () => {
      map.off('zoomend', updateVisibility)
      map.removeLayer(layerGroup)
    }
  }, [map, cables, nodeMap, visibleCableTypes, selectedFaultAlertCableId, isAdmin, onEditRoute, onDeleteCable])

  return null
}