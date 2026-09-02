import { createPathComponent } from '@react-leaflet/core'
import L from 'leaflet'
import 'leaflet.markercluster'
import 'leaflet.markercluster/dist/MarkerCluster.css'
import 'leaflet.markercluster/dist/MarkerCluster.Default.css'

interface MarkerClusterProps {
  children?: React.ReactNode
  maxClusterRadius?: number
  disableClusteringAtZoom?: number
  spiderfyOnMaxZoom?: boolean
  chunkedLoading?: boolean
}

const MarkerClusterGroup = createPathComponent<L.MarkerClusterGroup, MarkerClusterProps>(
  (props, context) => {
    const clusterGroup = L.markerClusterGroup({
      chunkedLoading: props.chunkedLoading ?? true,
      chunkInterval: 50,
      chunkDelay: 20,
      maxClusterRadius: props.maxClusterRadius ?? 50,
      disableClusteringAtZoom: props.disableClusteringAtZoom ?? 18,
      spiderfyOnMaxZoom: props.spiderfyOnMaxZoom ?? true,
      showCoverageOnHover: false,
    })

    return {
      instance: clusterGroup,
      context: { ...context, layerContainer: clusterGroup },
    }
  },
)

export default MarkerClusterGroup