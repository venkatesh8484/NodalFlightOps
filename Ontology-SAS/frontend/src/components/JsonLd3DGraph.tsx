import { useEffect, useMemo, useRef, useState } from 'react'
import ForceGraph2D from 'react-force-graph-2d'
import ForceGraph3D from 'react-force-graph-3d'
import SpriteText from 'three-spritetext'
import * as THREE from 'three'
import { FiZoomIn, FiZoomOut, FiChevronUp, FiChevronDown, FiChevronLeft, FiChevronRight } from 'react-icons/fi'

// Distinct color palette for clusters (like the reference graph image)
const CLUSTER_COLORS = [
  '#22c55e', // green
  '#60a5fa', // blue
  '#fbbf24', // gold
  '#f472b6', // pink
  '#a78bfa', // purple
  '#fb923c', // orange
  '#14b8a6', // teal
  '#e879f9', // fuchsia
  '#84cc16', // lime
  '#f43f5e', // rose
  '#38bdf8', // sky
  '#c084fc', // violet
]

function getClusterColor(index: number): string {
  return CLUSTER_COLORS[index % CLUSTER_COLORS.length]
}

type GraphNode = {
  id: string
  name: string
  type: string
  isCategory?: boolean
  isHub?: boolean
  isAlias?: boolean
  isMetadata?: boolean
  isBucket?: boolean
  clusterIndex?: number
  conceptId?: string
  status?: string
  preferredTerm?: string
  aliasCount?: number
  x?: number
  y?: number
  z?: number
  fx?: number
  fy?: number
  fz?: number
}

type GraphLink = {
  source: string
  target: string
  label: string
}

type GraphData = {
  nodes: GraphNode[]
  links: GraphLink[]
}

type JsonLd3DGraphProps = {
  jsonLdData: unknown
  mode: '2d' | '3d'
  offsetX: number
  offsetY: number
  onMove?: (dx: number, dy: number) => void
  moveStep?: number
  onAxisUpdate?: (axis: {
    centerX: number
    centerY: number
    centerZ: number
    appliedX: number
    appliedY: number
  }) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getNodeLabel(item: Record<string, unknown>, fallback: string) {
  const prefLabel = item['skos:prefLabel']
  if (typeof prefLabel === 'string' && prefLabel.trim()) {
    return prefLabel
  }
  if (isRecord(prefLabel) && typeof prefLabel['@value'] === 'string' && prefLabel['@value'].trim()) {
    return prefLabel['@value']
  }

  const exPreferred = item['ex:preferredLabel']
  if (typeof exPreferred === 'string' && exPreferred.trim()) {
    return exPreferred
  }

  const plainLabel = item.label
  if (typeof plainLabel === 'string' && plainLabel.trim()) {
    return plainLabel
  }

  return fallback
}

function parseJsonLdToGraph(jsonLdData: unknown): GraphData {
  if (!isRecord(jsonLdData)) {
    return { nodes: [], links: [] }
  }

  const nodesMap = new Map<string, GraphNode>()
  const links: GraphLink[] = []

  const graphItemsRaw = jsonLdData['@graph']
  const graphItems = Array.isArray(graphItemsRaw) ? graphItemsRaw : [jsonLdData]

  graphItems.forEach((item) => {
    if (!isRecord(item)) {
      return
    }

    const id = typeof item['@id'] === 'string' ? item['@id'] : ''
    if (!id) {
      return
    }

    const isCategory = item['ex:isCategory'] === true || 
                      (typeof item['@type'] === 'string' && item['@type'] === 'ex:Category')
    
    // Extract hub-spoke metadata for Phase 0 and Phase 1
    const isHub = item['ex:isHub'] === true
    const isAlias = item['ex:isAlias'] === true
    const isMetadata = item['ex:isMetadata'] === true
    const isBucket = item['ex:isBucket'] === true
    const clusterIndex = typeof item['ex:clusterIndex'] === 'number' ? item['ex:clusterIndex'] : undefined
    const conceptId = typeof item['ex:conceptId'] === 'string' ? item['ex:conceptId'] : undefined
    const status = typeof item['ex:status'] === 'string' ? item['ex:status'] : undefined
    const preferredTerm = typeof item['ex:preferredTerm'] === 'string' ? item['ex:preferredTerm'] : undefined
    const aliasCount = typeof item['ex:aliasCount'] === 'number' ? item['ex:aliasCount'] : undefined

    nodesMap.set(id, {
      id,
      name: getNodeLabel(item, id),
      type: typeof item['@type'] === 'string' ? item['@type'] : 'Concept',
      isCategory,
      isHub,
      isAlias,
      isMetadata,
      isBucket,
      clusterIndex,
      conceptId,
      status,
      preferredTerm,
      aliasCount,
    })
  })

  const ignoredKeys = new Set([
    '@id',
    '@type',
    'skos:prefLabel',
    'skos:altLabel',
    'skos:scopeNote',
    'ex:preferredLabel',
    'label',
    'name',
    'definition',
    'ex:definition',
    'synonym',
    'ex:synonym',
  ])

  const maxLinks = 260

  graphItems.forEach((item) => {
    if (!isRecord(item)) {
      return
    }

    const sourceId = typeof item['@id'] === 'string' ? item['@id'] : ''
    if (!sourceId) {
      return
    }

    Object.keys(item).forEach((key) => {
      if (ignoredKeys.has(key)) {
        return
      }

      const current = item[key]
      const targets = Array.isArray(current) ? current : [current]

      targets.forEach((target) => {
        if (links.length >= maxLinks) {
          return
        }

        let targetId = ''
        if (typeof target === 'string') {
          targetId = target
        } else if (isRecord(target) && typeof target['@id'] === 'string') {
          targetId = target['@id']
        }

        if (!targetId || !nodesMap.has(targetId) || targetId === sourceId) {
          return
        }

        links.push({
          source: sourceId,
          target: targetId,
          label: key.replace(/^.*:/, ''),
        })
      })
    })
  })

  return {
    nodes: Array.from(nodesMap.values()),
    links,
  }
}

/**
 * Auto-assign cluster indices to nodes that don't have them.
 * Uses star-decomposition: the top-N most connected nodes become hubs,
 * and each remaining node is assigned to the hub it's closest to.
 */
function autoAssignClusters(graphData: GraphData): GraphData {
  const { nodes, links } = graphData
  
  // Skip if clusters are already assigned
  if (nodes.some(n => n.clusterIndex !== undefined)) {
    return graphData
  }
  
  if (nodes.length === 0) return graphData
  
  // Count connections per node
  const connectionCount = new Map<string, number>()
  nodes.forEach(n => connectionCount.set(n.id, 0))
  links.forEach(l => {
    const src = typeof l.source === 'string' ? l.source : (l.source as any).id
    const tgt = typeof l.target === 'string' ? l.target : (l.target as any).id
    connectionCount.set(src, (connectionCount.get(src) || 0) + 1)
    connectionCount.set(tgt, (connectionCount.get(tgt) || 0) + 1)
  })
  
  // Build adjacency list
  const adj = new Map<string, Set<string>>()
  nodes.forEach(n => adj.set(n.id, new Set()))
  links.forEach(l => {
    const src = typeof l.source === 'string' ? l.source : (l.source as any).id
    const tgt = typeof l.target === 'string' ? l.target : (l.target as any).id
    adj.get(src)?.add(tgt)
    adj.get(tgt)?.add(src)
  })
  
  // Sort nodes by connection count descending
  const sorted = [...nodes].sort((a, b) => (connectionCount.get(b.id) || 0) - (connectionCount.get(a.id) || 0))
  
  // Pick top hub candidates (at least 3, up to sqrt(N) hubs)
  const hubCount = Math.max(3, Math.min(12, Math.ceil(Math.sqrt(nodes.length))))
  const hubIds = new Set<string>()
  const hubs: GraphNode[] = []
  
  for (const n of sorted) {
    if (hubs.length >= hubCount) break
    // Ensure hubs aren't neighbors of each other (to spread clusters)
    const tooClose = hubs.some(h => adj.get(h.id)?.has(n.id))
    if (!tooClose || hubs.length < 3) {
      hubIds.add(n.id)
      hubs.push(n)
    }
  }
  
  // Assign each hub a cluster index
  const nodeCluster = new Map<string, number>()
  hubs.forEach((h, i) => {
    nodeCluster.set(h.id, i)
    h.clusterIndex = i
    h.isHub = true
    h.isAlias = false
  })
  
  // Assign remaining nodes to the nearest hub via BFS distance
  const unassigned = nodes.filter(n => !hubIds.has(n.id))
  unassigned.forEach(n => {
    // Find which hub is closest (fewest hops)
    let bestCluster = 0
    let bestDist = Infinity
    
    for (let hi = 0; hi < hubs.length; hi++) {
      const hub = hubs[hi]
      // Direct neighbor?
      if (adj.get(hub.id)?.has(n.id)) {
        bestCluster = hi
        bestDist = 1
        break
      }
      // 2-hop?
      if (bestDist > 2) {
        for (const neighbor of adj.get(hub.id) || []) {
          if (adj.get(neighbor)?.has(n.id)) {
            bestCluster = hi
            bestDist = 2
            break
          }
        }
      }
    }
    
    // If not reachable within 2 hops, assign to least-populated cluster
    if (bestDist === Infinity) {
      const clusterSizes = new Map<number, number>()
      hubs.forEach((_, i) => clusterSizes.set(i, 0))
      nodeCluster.forEach((ci) => clusterSizes.set(ci, (clusterSizes.get(ci) || 0) + 1))
      let minSize = Infinity
      for (const [ci, size] of clusterSizes) {
        if (size < minSize) {
          minSize = size
          bestCluster = ci
        }
      }
    }
    
    n.clusterIndex = bestCluster
    n.isAlias = true
    n.isHub = false
    nodeCluster.set(n.id, bestCluster)
  })
  
  return { nodes, links }
}

/**
 * Apply hub-spoke positioning to graph nodes
 * Each cluster gets a random 3D position, with hub at center and aliases in a circle
 */
function applyHubSpokePositioning(graphData: GraphData): GraphData {
  const nodes = graphData.nodes
  const links = graphData.links
  
  const CLUSTER_SPREAD = 300
  const SPOKE_RADIUS = 50
  
  // Group nodes by cluster
  const clusters = new Map<number, GraphNode[]>()
  nodes.forEach(node => {
    if (node.clusterIndex !== undefined) {
      if (!clusters.has(node.clusterIndex)) {
        clusters.set(node.clusterIndex, [])
      }
      clusters.get(node.clusterIndex)!.push(node)
    }
  })
  
  // Position clusters in a circle arrangement for organic feel
  const clusterCount = clusters.size
  let clusterIdx = 0
  const clusterRadius = clusterCount <= 4 ? CLUSTER_SPREAD : CLUSTER_SPREAD * clusterCount / (2 * Math.PI)
  
  clusters.forEach((clusterNodes) => {
    const angle = (clusterIdx / clusterCount) * 2 * Math.PI - Math.PI / 2
    const clusterX = clusterRadius * Math.cos(angle)
    const clusterY = clusterRadius * Math.sin(angle)
    clusterIdx++
    
    const hub = clusterNodes.find(n => n.isHub)
    const aliases = clusterNodes.filter(n => n.isAlias)
    const bucket = clusterNodes.find(n => n.isBucket)
    
    if (hub) {
      hub.x = clusterX
      hub.y = clusterY
      hub.z = 0
    }
    
    aliases.forEach((alias, idx) => {
      const a = (idx / aliases.length) * 2 * Math.PI
      alias.x = clusterX + SPOKE_RADIUS * Math.cos(a)
      alias.y = clusterY + SPOKE_RADIUS * Math.sin(a)
      alias.z = 0
    })
    
    if (bucket) {
      bucket.x = clusterX
      bucket.y = clusterY + SPOKE_RADIUS * 1.2
      bucket.z = 0
    }
  })
  
  // Force ALL nodes to Z=0 so nothing overlaps in depth
  nodes.forEach(n => { n.z = 0; n.fz = 0 })
  
  return { nodes, links }
}

export default function JsonLd3DGraph({
  jsonLdData,
  mode,
  offsetX,
  offsetY,
  onMove,
  moveStep = 80,
  onAxisUpdate,
}: JsonLd3DGraphProps) {
  const [mountKey, setMountKey] = useState(0)
  
  // Increment mount key when jsonLdData changes to force remount
  useEffect(() => {
    setMountKey(prev => prev + 1)
  }, [jsonLdData])
  
  const graphData = useMemo(() => {
    const parsed = parseJsonLdToGraph(jsonLdData)
    console.log('[JsonLd3DGraph] Parsed:', parsed.nodes.length, 'nodes,', parsed.links.length, 'links')
    
    // Auto-assign clusters if not already set (e.g., Phase 6 Knowledge Graph)
    const clustered = autoAssignClusters(parsed)
    
    // Apply hub-spoke positioning for layout
    const hasHubSpokeData = clustered.nodes.some(n => n.isHub || n.isAlias)
    const positioned = hasHubSpokeData ? applyHubSpokePositioning(clustered) : clustered
    
    // Flatten all nodes to Z=0
    positioned.nodes.forEach(n => { n.z = 0; n.fz = 0 })
    
    // Ensure data structure is valid for react-force-graph
    return {
      nodes: positioned.nodes.map(node => ({ ...node })),
      links: positioned.links.map(link => ({ ...link }))
    }
  }, [jsonLdData])
  
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 })
  const graph2DRef = useRef<any>(null)
  const graph3DRef = useRef<any>(null)
  const hasFittedView = useRef(false)
  const base2DCenterRef = useRef({ x: 0, y: 0 })
  const base3DTargetRef = useRef({ x: 0, y: 0, z: 0 })
  const base3DCameraRef = useRef({ x: 0, y: 0, z: 120 })

  useEffect(() => {
    const node = containerRef.current
    if (!node) {
      return
    }

    const updateSize = () => {
      const width = Math.max(200, Math.floor(node.clientWidth))
      const height = Math.max(200, Math.floor(node.clientHeight))
      setCanvasSize((previous) => {
        if (previous.width === width && previous.height === height) {
          return previous
        }
        return { width, height }
      })
    }

    updateSize()

    const observer = new ResizeObserver(updateSize)
    observer.observe(node)

    return () => observer.disconnect()
  }, [])

  // Reset fit state when any of these change
  useEffect(() => {
    hasFittedView.current = false
    return () => {
      // Cleanup on unmount
      hasFittedView.current = false
    }
  }, [graphData, mode, canvasSize.width, canvasSize.height])

  // Initial fit when canvas and data are ready
  useEffect(() => {
    if (graphData.nodes.length === 0 || canvasSize.width === 0 || canvasSize.height === 0) {
      return
    }

    const timer = window.setTimeout(() => {
      if (!hasFittedView.current) {
        fitGraphToCenter(true)
      }
    }, 300)

    return () => window.clearTimeout(timer)
  }, [mode, graphData.nodes.length, canvasSize.width, canvasSize.height])

  useEffect(() => {
    if (graphData.nodes.length === 0) {
      return
    }

    if (mode === '2d' && graph2DRef.current) {
      const fg = graph2DRef.current
      const centerForce = fg.d3Force?.('center')
      centerForce?.x?.(0)
      centerForce?.y?.(0)
      fg.d3Force?.('charge')?.strength?.(-150)
      fg.d3Force?.('link')?.distance?.((link: any) => {
        const source = typeof link.source === 'object' ? link.source : graphData.nodes.find(n => n.id === link.source)
        return source?.isHub ? 80 : 50
      })
      fg.d3ReheatSimulation?.()
    } else if (mode === '3d' && graph3DRef.current) {
      const fg = graph3DRef.current
      const centerForce = fg.d3Force?.('center')
      centerForce?.x?.(0)
      centerForce?.y?.(0)
      centerForce?.z?.(0)
      // Strong repulsion to spread clusters apart
      fg.d3Force?.('charge')?.strength?.(-300)
      // Longer link distances for hubs
      fg.d3Force?.('link')?.distance?.((link: any) => {
        const source = typeof link.source === 'object' ? link.source : graphData.nodes.find(n => n.id === link.source)
        return source?.isHub ? 100 : 60
      })
      fg.d3ReheatSimulation?.()
    }
  }, [graphData, mode])

  const getGraphCenter = () => {
    const positioned = graphData.nodes.filter(
      (node) => Number.isFinite(node.x) && Number.isFinite(node.y),
    )

    if (positioned.length === 0) {
      return { x: 0, y: 0, z: 0 }
    }

    const xs = positioned.map((node) => Number(node.x))
    const ys = positioned.map((node) => Number(node.y))
    const zs = positioned.map((node) => Number(node.z ?? 0))

    return {
      x: (Math.min(...xs) + Math.max(...xs)) / 2,
      y: (Math.min(...ys) + Math.max(...ys)) / 2,
      z: (Math.min(...zs) + Math.max(...zs)) / 2,
    }
  }

  const recenterNodeCloud = () => {
    const positioned = graphData.nodes.filter(
      (node) => Number.isFinite(node.x) && Number.isFinite(node.y),
    )
    if (positioned.length === 0) {
      return { x: 0, y: 0, z: 0 }
    }

    const center = getGraphCenter()
    graphData.nodes.forEach((node) => {
      if (Number.isFinite(node.x)) {
        node.x = Number(node.x) - center.x
      }
      if (Number.isFinite(node.y)) {
        node.y = Number(node.y) - center.y
      }
      if (Number.isFinite(node.z)) {
        node.z = Number(node.z) - center.z
      }
      if (Number.isFinite(node.fx)) {
        node.fx = Number(node.fx) - center.x
      }
      if (Number.isFinite(node.fy)) {
        node.fy = Number(node.fy) - center.y
      }
      if (Number.isFinite(node.fz)) {
        node.fz = Number(node.fz) - center.z
      }
    })

    return center
  }

  const apply2DOffset = () => {
    if (!graph2DRef.current) {
      return
    }
    const zoom2d = Math.max(0.1, Number(graph2DRef.current.zoom?.() ?? 1))
    const appliedX = base2DCenterRef.current.x + offsetX / zoom2d
    const appliedY = base2DCenterRef.current.y + offsetY / zoom2d
    // Use centerAt without animation duration so it doesn't fight user zoom
    graph2DRef.current.centerAt(appliedX, appliedY, 0)
    onAxisUpdate?.({
      centerX: base2DCenterRef.current.x,
      centerY: base2DCenterRef.current.y,
      centerZ: 0,
      appliedX,
      appliedY,
    })
  }

  const apply3DOffset = () => {
    const graph = graph3DRef.current
    const camera = graph?.camera?.()
    const controls = graph?.controls?.()
    if (!graph || !camera || !controls) {
      return
    }

    const targetBase = base3DTargetRef.current
    const cameraBase = base3DCameraRef.current

    const distance = Math.max(
      1,
      Math.sqrt(
        (cameraBase.x - targetBase.x) ** 2 +
          (cameraBase.y - targetBase.y) ** 2 +
          (cameraBase.z - targetBase.z) ** 2,
      ),
    )
    const fov = Number(camera.fov ?? 60)
    const worldHeight = 2 * distance * Math.tan((fov * Math.PI) / 360)
    const worldPerPixel = worldHeight / Math.max(1, canvasSize.height)

    // camera matrix basis vectors: right (0..2), up (4..6)
    const e = camera.matrix.elements
    const right = { x: Number(e[0]), y: Number(e[1]), z: Number(e[2]) }
    const up = { x: Number(e[4]), y: Number(e[5]), z: Number(e[6]) }

    const sx = offsetX * worldPerPixel
    const sy = -offsetY * worldPerPixel

    const shift = {
      x: right.x * sx + up.x * sy,
      y: right.y * sx + up.y * sy,
      z: right.z * sx + up.z * sy,
    }

    const target = {
      x: targetBase.x + shift.x,
      y: targetBase.y + shift.y,
      z: targetBase.z + shift.z,
    }
    const cam = {
      x: cameraBase.x + shift.x,
      y: cameraBase.y + shift.y,
      z: cameraBase.z + shift.z,
    }

    graph.cameraPosition(cam, target, 140)
    onAxisUpdate?.({
      centerX: targetBase.x,
      centerY: targetBase.y,
      centerZ: targetBase.z,
      appliedX: target.x,
      appliedY: target.y,
    })
  }

  // Configure d3 forces for proper node spacing
  useEffect(() => {
    if (mode === '3d' && graph3DRef.current) {
      const fg = graph3DRef.current as any
      fg.d3Force?.('charge')?.strength(-80)
      fg.d3Force?.('link')?.distance(40)
    }
    if (mode === '2d' && graph2DRef.current) {
      const fg = graph2DRef.current as any
      fg.d3Force?.('charge')?.strength(-150)
      fg.d3Force?.('link')?.distance(60)
    }
  }, [mode, mountKey])

  // Zoom-to-pointer for 2D: intercept wheel events and zoom toward mouse position
  useEffect(() => {
    if (mode !== '2d') return
    const container = containerRef.current
    if (!container) return

    const onWheel = (e: WheelEvent) => {
      if (!graph2DRef.current) return
      e.preventDefault()

      const fg = graph2DRef.current
      const currentZoom = Math.max(0.01, Number(fg.zoom?.() ?? 1))
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
      const newZoom = Math.max(0.01, currentZoom * factor)

      // Canvas element is the first canvas inside the container
      const canvas = container.querySelector('canvas')
      if (!canvas) {
        fg.zoom(newZoom, 0)
        return
      }

      const rect = canvas.getBoundingClientRect()
      // Mouse position relative to canvas center in screen pixels
      const mouseScreenX = e.clientX - rect.left - rect.width / 2
      const mouseScreenY = e.clientY - rect.top - rect.height / 2

      // Current graph center in graph coords
      const center = fg.centerAt?.() ?? { x: 0, y: 0 }

      // Mouse position in graph coords before zoom
      const mouseGraphX = center.x + mouseScreenX / currentZoom
      const mouseGraphY = center.y + mouseScreenY / currentZoom

      // After zoom, shift center so mouse graph position stays under cursor
      const newCenterX = mouseGraphX - mouseScreenX / newZoom
      const newCenterY = mouseGraphY - mouseScreenY / newZoom

      fg.zoom(newZoom, 0)
      fg.centerAt(newCenterX, newCenterY, 0)
    }

    container.addEventListener('wheel', onWheel, { passive: false })
    return () => container.removeEventListener('wheel', onWheel)
  }, [mode, mountKey])

  const fitGraphToCenter = (force = false) => {
    if ((!force && hasFittedView.current) || graphData.nodes.length === 0) {
      return
    }

    hasFittedView.current = true
    recenterNodeCloud()

    if (mode === '2d' && graph2DRef.current) {
      base2DCenterRef.current = { x: 0, y: 0 }
      graph2DRef.current.zoomToFit(600, 10)
      window.setTimeout(() => {
        apply2DOffset()
      }, 240)
    } else if (mode === '3d' && graph3DRef.current) {
      graph3DRef.current.zoomToFit(300, 0)
      window.setTimeout(() => {
        const camera = graph3DRef.current?.camera?.()
        const controls = graph3DRef.current?.controls?.()
        const target = controls?.target
        const baseTarget = target
          ? { x: Number(target.x), y: Number(target.y), z: Number(target.z) }
          : { x: 0, y: 0, z: 0 }
        const baseCamera = camera?.position
          ? { x: Number(camera.position.x), y: Number(camera.position.y), z: Number(camera.position.z) }
          : { x: baseTarget.x, y: baseTarget.y, z: baseTarget.z + 120 }

        base3DTargetRef.current = baseTarget
        base3DCameraRef.current = baseCamera
        apply3DOffset()
      }, 240)
    }
  }

  const zoomIn = () => {
    if (mode === '2d' && graph2DRef.current) {
      const current = Math.max(0.1, Number(graph2DRef.current.zoom?.() ?? 1))
      graph2DRef.current.zoom(current * 1.2, 180)
      return
    }

    if (mode === '3d' && graph3DRef.current) {
      const controls = graph3DRef.current.controls?.()
      const camera = graph3DRef.current.camera?.()
      if (!controls || !camera) {
        return
      }
      const t = controls.target
      const cp = camera.position
      const dx = cp.x - t.x
      const dy = cp.y - t.y
      const dz = cp.z - t.z
      graph3DRef.current.cameraPosition(
        {
          x: t.x + dx * 0.85,
          y: t.y + dy * 0.85,
          z: t.z + dz * 0.85,
        },
        { x: t.x, y: t.y, z: t.z },
        180,
      )
    }
  }

  const zoomOut = () => {
    if (mode === '2d' && graph2DRef.current) {
      const current = Math.max(0.1, Number(graph2DRef.current.zoom?.() ?? 1))
      graph2DRef.current.zoom(current / 1.2, 180)
      return
    }

    if (mode === '3d' && graph3DRef.current) {
      const controls = graph3DRef.current.controls?.()
      const camera = graph3DRef.current.camera?.()
      if (!controls || !camera) {
        return
      }
      const t = controls.target
      const cp = camera.position
      const dx = cp.x - t.x
      const dy = cp.y - t.y
      const dz = cp.z - t.z
      graph3DRef.current.cameraPosition(
        {
          x: t.x + dx * 1.15,
          y: t.y + dy * 1.15,
          z: t.z + dz * 1.15,
        },
        { x: t.x, y: t.y, z: t.z },
        180,
      )
    }
  }

  // Track previous offset to compute delta — avoids re-centering on zoom
  const prevOffsetRef = useRef({ x: 0, y: 0 })

  // Reset delta tracker when graph or mode changes
  useEffect(() => {
    prevOffsetRef.current = { x: offsetX, y: offsetY }
  }, [graphData, mode])

  useEffect(() => {
    if (graphData.nodes.length === 0 || !hasFittedView.current) return

    const dx = offsetX - prevOffsetRef.current.x
    const dy = offsetY - prevOffsetRef.current.y
    prevOffsetRef.current = { x: offsetX, y: offsetY }

    if (dx === 0 && dy === 0) return

    if (mode === '2d' && graph2DRef.current) {
      const zoom2d = Math.max(0.1, Number(graph2DRef.current.zoom?.() ?? 1))
      const cur = graph2DRef.current.centerAt?.() ?? { x: 0, y: 0 }
      // Negate dx/dy: moving view "right" means graph center moves left in graph coords
      graph2DRef.current.centerAt(cur.x - dx / zoom2d, cur.y - dy / zoom2d, 0)
      return
    }

    if (mode === '3d' && graph3DRef.current) {
      apply3DOffset()
    }
  }, [offsetX, offsetY])

  // Fallback timer — only fires when graph/mode/canvas changes, NOT on every pan
  useEffect(() => {
    if (graphData.nodes.length === 0 || canvasSize.width === 0 || canvasSize.height === 0) {
      return
    }
    const timer = window.setTimeout(() => {
      if (!hasFittedView.current) {
        fitGraphToCenter(true)
      }
    }, 1500)

    return () => window.clearTimeout(timer)
  }, [graphData, mode, canvasSize.width, canvasSize.height])

  // Don't render until canvas size is ready and we have data
  const canRender = canvasSize.width > 0 && canvasSize.height > 0 && graphData.nodes.length > 0

  if (!canRender) {
    return (
      <div className="graph-3d-canvas" ref={containerRef} style={{ width: '100%', height: '100%' }}>
        <div style={{ 
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'center',
          height: '100%',
          color: 'rgba(255,255,255,0.4)',
          fontSize: '13px'
        }}>
          {graphData.nodes.length === 0 ? 'No graph data' : 'Loading graph...'}
        </div>
      </div>
    )
  }

  return (
    <div className="graph-3d-canvas" ref={containerRef} style={{ width: '100%', height: '100%' }}>
      {mode === '2d' ? (
        <ForceGraph2D
          key={`fg2d-${mountKey}-${mode}`}
          ref={graph2DRef}
          graphData={graphData}
          width={canvasSize.width}
          height={canvasSize.height}
          nodeLabel={(node) => {
            const n = node as GraphNode
            const color = n.clusterIndex !== undefined ? getClusterColor(n.clusterIndex) : '#60a5fa'
            if (n.isHub) {
              return `<div style="background: ${color}ee; padding: 8px 14px; border-radius: 8px; color: white; font-size: 14px; font-family: system-ui; font-weight: 600; box-shadow: 0 4px 16px ${color}80;">
                ${n.name}${n.conceptId ? `<div style="font-size:11px;opacity:0.8;margin-top:2px;">[${n.conceptId}]</div>` : ''}
              </div>`
            }
            return `<div style="background: rgba(0,0,0,0.85); padding: 6px 10px; border-radius: 6px; color: white; font-size: 12px; font-family: system-ui;">
              <strong style="color:${color}">${n.name}</strong>
            </div>`
          }}
          nodeVal={(node) => {
            const n = node as GraphNode
            if (n.isBucket) return 30
            if (n.isHub) return 20
            if (n.isAlias) return 5
            if (n.isCategory) return 20
            return 6
          }}
          nodeCanvasObject={(node, ctx, globalScale) => {
            const n = node as GraphNode
            const color = n.clusterIndex !== undefined ? getClusterColor(n.clusterIndex) : '#60a5fa'
            const label = n.name
            
            if (n.isHub || n.isBucket) {
              // Large filled circle with text inside
              const size = n.isBucket ? 14 : 12
              ctx.beginPath()
              ctx.arc(n.x!, n.y!, size, 0, 2 * Math.PI)
              ctx.fillStyle = n.isBucket ? '#fbbf24' : color
              ctx.fill()
              
              // Glow ring
              ctx.beginPath()
              ctx.arc(n.x!, n.y!, size + 2, 0, 2 * Math.PI)
              ctx.strokeStyle = (n.isBucket ? '#fbbf24' : color) + '40'
              ctx.lineWidth = 3
              ctx.stroke()
              
              // Text inside
              const fontSize = Math.min(10, Math.max(3, Math.min(12 / globalScale, (size * 1.6) / label.length * 2)))
              ctx.font = `bold ${fontSize}px system-ui, -apple-system, sans-serif`
              ctx.textAlign = 'center'
              ctx.textBaseline = 'middle'
              ctx.fillStyle = '#ffffff'
              ctx.fillText(label, n.x!, n.y!)
            } else {
              // Small dot for aliases
              const size = 4
              ctx.beginPath()
              ctx.arc(n.x!, n.y!, size, 0, 2 * Math.PI)
              ctx.fillStyle = color + 'cc'
              ctx.fill()
              
              // Label below
              const fontSize = Math.min(10, Math.max(2.5, 10 / globalScale))
              ctx.font = `${fontSize}px system-ui, -apple-system, sans-serif`
              ctx.textAlign = 'center'
              ctx.textBaseline = 'top'
              ctx.fillStyle = color
              ctx.fillText(label, n.x!, n.y! + size + 2)
            }
          }}
          nodeCanvasObjectMode={() => 'replace'}
          linkLabel={(link) => {
            const l = link as GraphLink
            return `<div style="background: rgba(0,0,0,0.85); padding: 6px 10px; border-radius: 4px; color: #a78bfa; font-size: 12px; font-family: system-ui; font-weight: 500;">
              ${l.label}
            </div>`
          }}
          linkColor={() => 'rgba(255, 255, 255, 0.08)'}
          linkWidth={0.8}
          linkDirectionalArrowLength={4}
          linkDirectionalArrowRelPos={0.9}
          linkDirectionalArrowColor={() => 'rgba(255, 255, 255, 0.15)'}
          linkCurvature={0.15}
          cooldownTime={2500}
          cooldownTicks={150}
          warmupTicks={80}
          d3AlphaDecay={0.015}
          d3VelocityDecay={0.25}
          onEngineStop={() => {
            console.log('[Graph 2D] Engine stopped')
            fitGraphToCenter(false)
          }}
          backgroundColor="rgba(8, 12, 24, 1)"
        />
      ) : (
        <ForceGraph3D
          key={`fg3d-${mountKey}-${mode}`}
          ref={graph3DRef}
          graphData={graphData}
          width={canvasSize.width}
          height={canvasSize.height}
          nodeLabel={(node) => {
            const n = node as GraphNode
            const color = n.clusterIndex !== undefined ? getClusterColor(n.clusterIndex) : '#60a5fa'
            if (n.isHub) {
              return `<div style="background: ${color}ee; padding: 8px 14px; border-radius: 8px; color: white; font-size: 14px; font-family: system-ui; font-weight: 600; box-shadow: 0 4px 16px ${color}80;">
                ${n.name}${n.conceptId ? `<div style="font-size:11px;opacity:0.8;margin-top:2px;">[${n.conceptId}]</div>` : ''}
              </div>`
            }
            return `<div style="background: rgba(0,0,0,0.85); padding: 6px 10px; border-radius: 6px; color: white; font-size: 12px; font-family: system-ui;">
              <strong style="color:${color}">${n.name}</strong>
            </div>`
          }}
          nodeThreeObject={(node) => {
            const n = node as GraphNode
            const color = n.clusterIndex !== undefined ? getClusterColor(n.clusterIndex) : '#60a5fa'
            
            if (n.isHub) {
              // Large sphere with text BELOW it (not inside, to avoid overlap)
              const group = new THREE.Group()
              
              // Main sphere — slightly smaller so text has room
              const geometry = new THREE.SphereGeometry(9, 32, 32)
              const material = new THREE.MeshLambertMaterial({
                color: new THREE.Color(color),
                transparent: true,
                opacity: 0.92,
                emissive: new THREE.Color(color),
                emissiveIntensity: 0.35,
              })
              const sphere = new THREE.Mesh(geometry, material)
              group.add(sphere)
              
              // Glow ring
              const ringGeo = new THREE.RingGeometry(10, 11.5, 32)
              const ringMat = new THREE.MeshBasicMaterial({
                color: new THREE.Color(color),
                transparent: true,
                opacity: 0.2,
                side: THREE.DoubleSide,
              })
              const ring = new THREE.Mesh(ringGeo, ringMat)
              group.add(ring)
              
              // Text label BELOW the sphere so it's always visible
              const displayName = n.name.length > 18 ? n.name.substring(0, 16) + '…' : n.name
              const label = new SpriteText(displayName)
              label.color = '#ffffff'
              label.textHeight = 3.5
              label.fontWeight = 'bold'
              label.backgroundColor = color + 'cc'
              label.padding = 1.5
              label.borderRadius = 2
              label.position.set(0, -12, 0)
              group.add(label)
              
              return group
            }
            
            if (n.isBucket) {
              const group = new THREE.Group()
              const geometry = new THREE.SphereGeometry(7, 24, 24)
              const material = new THREE.MeshLambertMaterial({
                color: new THREE.Color('#fbbf24'),
                transparent: true,
                opacity: 0.85,
                emissive: new THREE.Color('#fbbf24'),
                emissiveIntensity: 0.35,
              })
              group.add(new THREE.Mesh(geometry, material))
              const bucketName = n.name.length > 18 ? n.name.substring(0, 16) + '…' : n.name
              const label = new SpriteText(bucketName)
              label.color = '#ffffff'
              label.textHeight = 3
              label.fontWeight = 'bold'
              label.backgroundColor = '#fbbf24cc'
              label.padding = 1.2
              label.borderRadius = 2
              label.position.set(0, -10, 0)
              group.add(label)
              return group
            }
            
            // Alias / small nodes - colored dot with subtle label below
            const group = new THREE.Group()
            const geometry = new THREE.SphereGeometry(5, 16, 16)
            const material = new THREE.MeshLambertMaterial({
              color: new THREE.Color(color),
              transparent: true,
              opacity: 0.75,
              emissive: new THREE.Color(color),
              emissiveIntensity: 0.3,
            })
            group.add(new THREE.Mesh(geometry, material))
            
            const label = new SpriteText(n.name)
            label.color = color
            label.textHeight = 3
            label.fontWeight = 'normal'
            label.backgroundColor = 'rgba(0,0,0,0.4)'
            label.padding = 0.8
            label.borderRadius = 1
            label.position.set(0, -7, 0)
            group.add(label)
            
            return group
          }}
          nodeThreeObjectExtend={false}
          linkLabel={(link) => {
            const l = link as GraphLink
            return `<div style="background: rgba(0,0,0,0.85); padding: 6px 10px; border-radius: 4px; color: #a78bfa; font-size: 12px; font-family: system-ui; font-weight: 500;">
              ${l.label}
            </div>`
          }}
          linkColor={(link) => {
            const l = link as any
            const sourceNode = typeof l.source === 'object' ? l.source : graphData.nodes.find(n => n.id === l.source)
            if (sourceNode?.clusterIndex !== undefined) {
              return getClusterColor(sourceNode.clusterIndex) + '88'
            }
            return 'rgba(150, 180, 220, 0.35)'
          }}
          linkWidth={1.2}
          linkDirectionalArrowLength={3}
          linkDirectionalArrowRelPos={0.85}
          linkDirectionalArrowColor={(link) => {
            const l = link as any
            const sourceNode = typeof l.source === 'object' ? l.source : graphData.nodes.find(n => n.id === l.source)
            if (sourceNode?.clusterIndex !== undefined) {
              return getClusterColor(sourceNode.clusterIndex) + 'aa'
            }
            return 'rgba(150, 180, 220, 0.5)'
          }}
          linkCurvature={0.15}
          linkOpacity={0.4}
          enableNodeDrag={true}
          enableNavigationControls={true}
          showNavInfo={false}
          cooldownTime={4000}
          cooldownTicks={300}
          warmupTicks={100}
          d3AlphaDecay={0.008}
          d3VelocityDecay={0.15}
          d3AlphaMin={0.001}
          onEngineStop={() => {
            console.log('[Graph 3D] Engine stopped')
            // Only fit on first stop — never re-center after user has panned/zoomed
            if (!hasFittedView.current) {
              fitGraphToCenter(true)
            }
          }}
          backgroundColor="rgba(8, 12, 24, 1)"
        />
      )}

      <div className="graph-controls-overlay" aria-label="Graph movement controls">
        <div className="graph-controls-zoom">
          <button type="button" className="ghost-button" onClick={zoomIn} title="Zoom in">
            <FiZoomIn size={18} />
          </button>
          <button type="button" className="ghost-button" onClick={zoomOut} title="Zoom out">
            <FiZoomOut size={18} />
          </button>
        </div>

        <div className="graph-controls-pad">
          <button type="button" className="ghost-button" aria-label="Move up" onClick={() => onMove?.(0, -moveStep)}>
            <FiChevronUp size={18} />
          </button>
          <button type="button" className="ghost-button" aria-label="Move left" onClick={() => onMove?.(-moveStep, 0)}>
            <FiChevronLeft size={18} />
          </button>
          <button type="button" className="ghost-button" aria-label="Move right" onClick={() => onMove?.(moveStep, 0)}>
            <FiChevronRight size={18} />
          </button>
          <button type="button" className="ghost-button" aria-label="Move down" onClick={() => onMove?.(0, moveStep)}>
            <FiChevronDown size={18} />
          </button>
        </div>
      </div>
    </div>
  )
}