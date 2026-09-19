import { Canvas } from '@react-three/fiber'
import { OrbitControls, Text, Sphere, Line } from '@react-three/drei'
import { useRef } from 'react'
import * as THREE from 'three'

type PhaseWorkflowProps = {
  activePhase?: number
  onPhaseClick?: (index: number) => void
}

const phases = [
  { name: 'Controlled Vocabulary', position: [-5, 2, 0], color: '#60a5fa' },
  { name: 'Metadata Standard', position: [-3, 0, 0], color: '#34d399' },
  { name: 'Taxonomy', position: [-1, -2, 0], color: '#fbbf24' },
  { name: 'Thesaurus', position: [1, -2, 0], color: '#f87171' },
  { name: 'Ontology', position: [3, 0, 0], color: '#a78bfa' },
  { name: 'Knowledge Graph', position: [5, 2, 0], color: '#fb923c' },
]

function PhaseNode({ position, color, label, isActive, onClick }: any) {
  const meshRef = useRef<THREE.Mesh>(null)

  return (
    <group position={position} onClick={onClick}>
      <Sphere args={[0.3, 32, 32]} ref={meshRef}>
        <meshStandardMaterial
          color={color}
          emissive={isActive ? color : '#000'}
          emissiveIntensity={isActive ? 0.5 : 0}
          metalness={0.3}
          roughness={0.4}
        />
      </Sphere>
      <Text
        position={[0, -0.6, 0]}
        fontSize={0.25}
        color="white"
        anchorX="center"
        anchorY="middle"
      >
        {label}
      </Text>
    </group>
  )
}

function ConnectionLine({ start, end }: { start: [number, number, number]; end: [number, number, number] }) {
  const points = [new THREE.Vector3(...start), new THREE.Vector3(...end)]
  return (
    <Line
      points={points}
      color="rgba(255, 255, 255, 0.2)"
      lineWidth={1}
    />
  )
}

export default function PhaseWorkflow({ activePhase = -1, onPhaseClick }: PhaseWorkflowProps) {
  return (
    <Canvas camera={{ position: [0, 0, 12], fov: 50 }}>
      <ambientLight intensity={0.5} />
      <pointLight position={[10, 10, 10]} intensity={1} />
      <pointLight position={[-10, -10, -10]} intensity={0.5} />

      {phases.map((phase, index) => {
        if (index < phases.length - 1) {
          return (
            <ConnectionLine
              key={`line-${index}`}
              start={phase.position as [number, number, number]}
              end={phases[index + 1].position as [number, number, number]}
            />
          )
        }
        return null
      })}

      {phases.map((phase, index) => (
        <PhaseNode
          key={index}
          position={phase.position}
          color={phase.color}
          label={`${index + 1}`}
          isActive={activePhase === index}
          onClick={() => onPhaseClick?.(index)}
        />
      ))}

      <OrbitControls enableZoom={false} autoRotate autoRotateSpeed={0.5} />
    </Canvas>
  )
}
