"use client";
import { Html, OrbitControls } from "@react-three/drei";
import { Canvas, type ThreeEvent, useFrame, useThree } from "@react-three/fiber";
import { memo, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useLive } from "@/lib/live";

export interface Device { x: number; z: number; heading: number; length?: number }
export interface PlazaNet {
  id: string; name: string; kind: string; p: [number, number]; q: [number, number]; side: number; has_lane: boolean; bays: number;
  tracks: Record<string, [number, number][]>; bay_tracks: [number, number][][]; devices: Record<string, any>;
}
export interface Network { edges: { id: string; pts: [number, number][]; lanes: number }[]; plazas: PlazaNet[]; landmarks: Record<string, { x: number; z: number; label: string }> }

const MAX_TRUCKS = 1200;
const STATE_COLORS = [new THREE.Color("#cdd7e3"), new THREE.Color("#2fe08a"), new THREE.Color("#ffb020"), new THREE.Color("#ff4d4d")];
const HOME = { pos: new THREE.Vector3(-360, 2750, 2150), target: new THREE.Vector3(-360, 0, 230) };

function ribbon(pts: [number, number][], width: number, y: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const index: number[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len;
    const nz = dx / len;
    positions.push(pts[i][0] + (nx * width) / 2, y, pts[i][1] + (nz * width) / 2, pts[i][0] - (nx * width) / 2, y, pts[i][1] - (nz * width) / 2);
    if (i < n - 1) {
      const k = i * 2;
      index.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

const Ribbon = memo(function Ribbon({ pts, width, y, color, opacity = 1, emissive }: { pts: [number, number][]; width: number; y: number; color: string; opacity?: number; emissive?: string }) {
  const geo = useMemo(() => ribbon(pts, width, y), [pts, width, y]);
  return (
    <mesh geometry={geo}>
      <meshStandardMaterial color={color} side={THREE.DoubleSide} transparent={opacity < 1} opacity={opacity} emissive={emissive || "#000"} emissiveIntensity={emissive ? 0.5 : 0} roughness={0.95} metalness={0} />
    </mesh>
  );
});

function Box({ p, s, color, emissive, rotY = 0 }: { p: [number, number, number]; s: [number, number, number]; color: string; emissive?: string; rotY?: number }) {
  return (
    <mesh position={p} rotation={[0, rotY, 0]}>
      <boxGeometry args={s} />
      <meshStandardMaterial color={color} emissive={emissive || "#000"} emissiveIntensity={emissive ? 1.1 : 0} roughness={0.7} metalness={0.25} />
    </mesh>
  );
}

function Land() {
  const land = useMemo(() => {
    const s = new THREE.Shape();
    s.moveTo(-4200, -2800);
    s.lineTo(1500, -2800);
    s.lineTo(1320, -1200);
    s.lineTo(1120, -640);
    s.lineTo(940, -280);
    s.lineTo(1000, 120);
    s.lineTo(1080, 520);
    s.lineTo(1100, 860);
    s.lineTo(620, 1000);
    s.lineTo(120, 1150);
    s.lineTo(-200, 1750);
    s.lineTo(-4200, 2300);
    s.lineTo(-4200, -2800);
    return new THREE.ShapeGeometry(s, 8);
  }, []);
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -2, 0]}>
        <planeGeometry args={[14000, 12000]} />
        <meshStandardMaterial color="#0a2a47" roughness={0.3} metalness={0.5} />
      </mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, -0.5, 0]} geometry={land}>
        <meshStandardMaterial color="#1b2a3a" roughness={1} side={THREE.DoubleSide} />
      </mesh>
      <gridHelper args={[9000, 45, "#25374c", "#21324a"]} position={[-800, 0, 0]} />
    </group>
  );
}

function Portal({ x, z, heading, width = 16, color = "#425670", beam }: { x: number; z: number; heading: number; width?: number; color?: string; beam?: string }) {
  return (
    <group position={[x, 0, z]} rotation={[0, -heading, 0]}>
      <Box p={[0, 3.5, -width / 2]} s={[0.7, 7, 0.7]} color={color} />
      <Box p={[0, 3.5, width / 2]} s={[0.7, 7, 0.7]} color={color} />
      <Box p={[0, 7.1, 0]} s={[0.9, 0.9, width]} color={color} />
      {beam && <Box p={[0, 6.5, 0]} s={[0.35, 0.35, width - 1.5]} color={beam} emissive={beam} />}
    </group>
  );
}

function Pole({ x, z, heading, head }: { x: number; z: number; heading: number; head: string }) {
  return (
    <group position={[x, 0, z]} rotation={[0, -heading, 0]}>
      <Box p={[0, 3, 0]} s={[0.45, 6, 0.45]} color="#7a90ad" />
      <Box p={[0, 6.2, 0.9]} s={[1.6, 0.9, 0.9]} color="#22324a" emissive={head} />
    </group>
  );
}

/** A plaza: sensors, cameras, RFID, LiDAR portal, LED gantry, lane, static decks and control room. */
function PlazaModel({ plaza, gantryRefs, onSelect }: { plaza: PlazaNet; gantryRefs: React.MutableRefObject<Record<string, THREE.MeshStandardMaterial[]>>; onSelect: (id: string) => void }) {
  const d = plaza.devices;
  const h = d.gantry.heading as number;
  const setGantry = (m: THREE.MeshStandardMaterial | null) => {
    if (!m) return;
    const list = (gantryRefs.current[plaza.id] ||= []);
    if (!list.includes(m)) list.push(m);
  };
  return (
    <group>
      <Ribbon pts={plaza.tracks.approach} width={11} y={0.3} color="#44597a" />
      <Ribbon pts={plaza.tracks.to_gantry} width={11} y={0.3} color="#44597a" />
      <Ribbon pts={plaza.tracks.main_out} width={11} y={0.3} color="#44597a" />
      <Ribbon pts={plaza.tracks.merge} width={11} y={0.3} color="#44597a" />
      {plaza.has_lane && (
        <>
          <Ribbon pts={plaza.tracks.lane_approach} width={6.5} y={0.32} color="#1d3a52" />
          <Ribbon pts={plaza.tracks.lane_zone} width={7.5} y={0.34} color="#14506f" emissive="#0d6d97" />
          <Ribbon pts={plaza.tracks.lane_exit} width={6.5} y={0.32} color="#1d3a52" />
        </>
      )}
      <Ribbon pts={plaza.tracks.queue} width={6.5} y={0.32} color="#3a3324" />
      <Ribbon pts={plaza.tracks.collector} width={6.5} y={0.32} color="#2a3040" />
      {plaza.bay_tracks.map((b, i) => <Ribbon key={i} pts={b} width={6} y={0.33} color="#40382a" />)}
      {(d.bays as Device[]).map((b, i) => (
        <Box key={i} p={[b.x, 0.45, b.z]} s={[22, 0.3, 5]} rotY={-b.heading} color="#57503d" />
      ))}

      {/* Quartz WIM rows, three staggered strips */}
      {[-3, 0, 3].map((off, i) => (
        <mesh key={i} position={[d.sensor_rows.x + Math.cos(h) * off, 0.42, d.sensor_rows.z + Math.sin(h) * off]} rotation={[0, -h, 0]}>
          <boxGeometry args={[0.6, 0.12, 9.6]} />
          <meshStandardMaterial color="#38bdf8" emissive="#38bdf8" emissiveIntensity={1.4} />
        </mesh>
      ))}
      <Portal x={d.lidar.x} z={d.lidar.z} heading={h} beam="#7dd3fc" />
      <Pole x={d.anpr.x} z={d.anpr.z} heading={h} head="#a78bfa" />
      <Pole x={d.rfid.x} z={d.rfid.z} heading={h} head="#22d3ee" />
      <Box p={[d.cabinet.x, 1.4, d.cabinet.z]} s={[3, 2.8, 2]} rotY={-h} color="#5b7391" emissive="#0b3a56" />

      {/* LED gantry: colour comes from the live decision stream */}
      <group position={[d.gantry.x, 0, d.gantry.z]} rotation={[0, -h, 0]}>
        <Box p={[0, 4.5, -8.5]} s={[0.8, 9, 0.8]} color="#8299b6" />
        <Box p={[0, 4.5, 8.5]} s={[0.8, 9, 0.8]} color="#8299b6" />
        <Box p={[0, 9, 0]} s={[1, 1.1, 17]} color="#8299b6" />
        <mesh position={[-0.7, 9, 0]}>
          <boxGeometry args={[0.3, 1.6, 12]} />
          <meshStandardMaterial ref={setGantry} color="#2fe08a" emissive="#2fe08a" emissiveIntensity={2} />
        </mesh>
      </group>

      {plaza.has_lane && (
        <>
          <Portal x={d.lane_lidar.x} z={d.lane_lidar.z} heading={h} width={11} beam="#7dd3fc" />
          <Pole x={d.lane_anpr.x} z={d.lane_anpr.z} heading={h} head="#a78bfa" />
          <Pole x={d.lane_rfid.x} z={d.lane_rfid.z} heading={h} head="#22d3ee" />
          {/* Per-wheel scale pairs in the measuring zone */}
          {[-18, -6, 6, 18].map((off, i) => (
            <mesh key={i} position={[d.lane_zone.x + Math.cos(h) * off, 0.44, d.lane_zone.z + Math.sin(h) * off]} rotation={[0, -h, 0]}>
              <boxGeometry args={[1.1, 0.1, 6.8]} />
              <meshStandardMaterial color="#67e8f9" emissive="#67e8f9" emissiveIntensity={1} />
            </mesh>
          ))}
        </>
      )}

      {/* Control room: clicking any building opens the station */}
      <group position={[d.control_room.x, 0, d.control_room.z]} rotation={[0, -h, 0]} onClick={(e) => { e.stopPropagation(); onSelect(plaza.id); }}>
        <Box p={[0, 3.5, 0]} s={[26, 7, 14]} color="#4a607c" />
        <Box p={[0, 5.2, 7.1]} s={[22, 2, 0.2]} color="#0f2e44" emissive="#1f7fae" />
        <Box p={[0, 7.3, 0]} s={[27, 0.6, 15]} color="#66809f" />
      </group>
      {plaza.kind === "origin" && <OriginProps plaza={plaza} />}
    </group>
  );
}

function OriginProps({ plaza }: { plaza: PlazaNet }) {
  const { x, z } = plaza.devices.control_room as Device;
  const props = useMemo(() => {
    const out: { p: [number, number]; r: number; h: number }[] = [];
    for (let i = 0; i < 5; i++) out.push({ p: [x + (i - 2) * 26, z - 42 - (i % 2) * 18], r: 12 + (i % 3) * 3, h: plaza.id === "origin_quarry" ? 10 + i * 2 : 22 + (i % 2) * 8 });
    return out;
  }, [x, z, plaza.id]);
  return (
    <group>
      {props.map((o, i) => (
        <mesh key={i} position={[o.p[0], plaza.id === "origin_quarry" ? o.h / 2 : o.h / 2, o.p[1]]}>
          {plaza.id === "origin_quarry" ? <coneGeometry args={[o.r * 1.5, o.h, 10]} /> : plaza.id === "origin_cement" ? <cylinderGeometry args={[o.r * 0.6, o.r * 0.6, o.h * 1.5, 16]} /> : <cylinderGeometry args={[o.r, o.r, o.h * 0.5, 22]} />}
          <meshStandardMaterial color={plaza.id === "origin_quarry" ? "#4a4639" : plaza.id === "origin_cement" ? "#596877" : "#46586b"} roughness={0.9} />
        </mesh>
      ))}
    </group>
  );
}

function PortModel() {
  const stacks = useRef<THREE.InstancedMesh>(null);
  const COUNT = 900;
  useLayoutEffect(() => {
    const m = stacks.current;
    if (!m) return;
    const palette = ["#7a3b35", "#33597e", "#2f6b5f", "#8a6a2f", "#55606e", "#45507f"].map((c) => new THREE.Color(c));
    const o = new THREE.Object3D();
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    let i = 0;
    for (let row = 0; row < 12 && i < COUNT; row++) {
      for (let col = 0; col < 16 && i < COUNT; col++) {
        const levels = 1 + Math.floor(rnd() * 4);
        for (let l = 0; l < levels && i < COUNT; l++) {
          o.position.set(760 + col * 15 + row * 7, 1.5 + l * 3, 560 + row * 9 - col * 7 + 60);
          o.rotation.y = -0.75;
          o.scale.set(13, 2.9, 3.2);
          o.updateMatrix();
          m.setMatrixAt(i, o.matrix);
          m.setColorAt(i, palette[Math.floor(rnd() * palette.length)]);
          i++;
        }
      }
    }
    m.count = i;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, []);
  const cranes: [number, number][] = [[950, 780], [1000, 725], [1050, 670], [895, 835]];
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, -0.75]} position={[860, 0.1, 660]}>
        <planeGeometry args={[560, 300]} />
        <meshStandardMaterial color="#1a2534" roughness={1} />
      </mesh>
      <instancedMesh ref={stacks} args={[undefined, undefined, COUNT]}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial roughness={0.8} />
      </instancedMesh>
      {cranes.map(([x, z], i) => (
        <group key={i} position={[x, 0, z]} rotation={[0, -0.75 - Math.PI / 2, 0]}>
          {[[-9, -7], [9, -7], [-9, 7], [9, 7]].map(([a, b], k) => <Box key={k} p={[a, 15, b]} s={[1.6, 30, 1.6]} color="#2f6ea5" />)}
          <Box p={[0, 30, 8]} s={[3, 3, 96]} color="#3b82b8" />
          <Box p={[0, 24, 32]} s={[5, 5, 5]} color="#d9e2ec" emissive="#334155" />
          <Box p={[0, 38, -6]} s={[2, 18, 2]} color="#2f6ea5" />
        </group>
      ))}
      <Box p={[620, 4, 478]} s={[46, 8, 14]} rotY={0.75} color="#2c3d53" />
      <Box p={[620, 9, 478]} s={[58, 1, 22]} rotY={0.75} color="#3a4e68" emissive="#0b3a56" />
    </group>
  );
}

function Trucks({ selected, onSelect }: { selected: string | null; onSelect: (id: string) => void }) {
  const cab = useRef<THREE.InstancedMesh>(null);
  const trailer = useRef<THREE.InstancedMesh>(null);
  const glow = useRef<THREE.InstancedMesh>(null);
  const pick = useRef<THREE.InstancedMesh>(null);
  const ring = useRef<THREE.Mesh>(null);
  const heroRing = useRef<THREE.Mesh>(null);
  const ids = useRef<string[]>([]);
  const positions = useRef(new Map<string, { x: number; z: number; h: number; tx: number; tz: number; th: number; state: number; hero: number }>());
  const frameRef = useLive.getState().frameRef;
  const lastAt = useRef(0);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const color = useMemo(() => new THREE.Color(), []);
  const { camera } = useThree();
  const boundsClock = useRef(0);

  const glowTex = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d")!;
    const r = g.createRadialGradient(32, 32, 2, 32, 32, 32);
    r.addColorStop(0, "rgba(255,255,255,0.75)");
    r.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = r;
    g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  }, []);

  useFrame((_, dt) => {
    const frame = frameRef.current;
    const map = positions.current;
    if (frame && frameRef.at !== lastAt.current) {
      lastAt.current = frameRef.at;
      const seen = new Set<string>();
      for (const r of frame.trucks) {
        seen.add(r[0]);
        const cur = map.get(r[0]);
        if (cur) {
          cur.tx = r[1]; cur.tz = r[2]; cur.th = r[3]; cur.state = r[4]; cur.hero = r[5];
        } else {
          map.set(r[0], { x: r[1], z: r[2], h: r[3], tx: r[1], tz: r[2], th: r[3], state: r[4], hero: r[5] });
        }
      }
      for (const k of map.keys()) if (!seen.has(k)) map.delete(k);
      ids.current = Array.from(map.keys()).slice(0, MAX_TRUCKS);
    }
    const scale = THREE.MathUtils.clamp(camera.position.distanceTo((controlsTarget.current as THREE.Vector3)) / 520, 1, 2.3);
    const k = Math.min(1, dt * 7);
    const list = ids.current;
    let heroAt: { x: number; z: number } | null = null;
    let selAt: { x: number; z: number } | null = null;
    for (let i = 0; i < list.length; i++) {
      const t = map.get(list[i]);
      if (!t) continue;
      if (Math.hypot(t.tx - t.x, t.tz - t.z) > 150) {
        t.x = t.tx; t.z = t.tz; t.h = t.th;
      } else {
        t.x += (t.tx - t.x) * k;
        t.z += (t.tz - t.z) * k;
        let dh = t.th - t.h;
        if (dh > Math.PI) dh -= 2 * Math.PI;
        if (dh < -Math.PI) dh += 2 * Math.PI;
        t.h += dh * k;
      }
      const cos = Math.cos(t.h);
      const sin = Math.sin(t.h);
      dummy.rotation.set(0, -t.h, 0);
      dummy.scale.set(scale, scale, scale);
      dummy.position.set(t.x + cos * 6.1 * scale, 1.9 * scale, t.z + sin * 6.1 * scale);
      dummy.updateMatrix();
      cab.current!.setMatrixAt(i, dummy.matrix);
      dummy.position.set(t.x - cos * 1.4 * scale, 2.0 * scale, t.z - sin * 1.4 * scale);
      dummy.updateMatrix();
      trailer.current!.setMatrixAt(i, dummy.matrix);
      dummy.position.set(t.x, 2.0, t.z);
      dummy.scale.set(scale * 1.4, scale * 1.4, scale * 1.4);
      dummy.updateMatrix();
      pick.current!.setMatrixAt(i, dummy.matrix);
      dummy.rotation.set(-Math.PI / 2, 0, 0);
      dummy.position.set(t.x, 0.55, t.z);
      dummy.scale.set(scale * 19, scale * 19, 1);
      dummy.updateMatrix();
      glow.current!.setMatrixAt(i, dummy.matrix);
      color.copy(STATE_COLORS[t.state] || STATE_COLORS[0]);
      trailer.current!.setColorAt(i, color);
      glow.current!.setColorAt(i, color);
      if (t.hero) heroAt = t;
      if (list[i] === selected) selAt = t;
    }
    for (const m of [cab.current!, trailer.current!, glow.current!, pick.current!]) {
      m.count = list.length;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    boundsClock.current += dt;
    if (boundsClock.current > 0.4) {
      boundsClock.current = 0;
      pick.current!.computeBoundingSphere();
    }
    if (ring.current) {
      ring.current.visible = !!selAt;
      if (selAt) {
        ring.current.position.set(selAt.x, 1, selAt.z);
        ring.current.scale.setScalar(scale);
      }
    }
    if (heroRing.current) {
      heroRing.current.visible = !!heroAt;
      if (heroAt) {
        heroRing.current.position.set(heroAt.x, 0.9, heroAt.z);
        heroRing.current.scale.setScalar(scale);
      }
    }
    truckPositionRef.current = selAt || heroAt;
    followTargets.current = { selected: selAt, hero: heroAt };
  });

  const click = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (e.instanceId === undefined) return;
    const id = ids.current[e.instanceId];
    if (id) onSelect(id);
  };

  return (
    <group>
      <instancedMesh ref={cab} args={[undefined, undefined, MAX_TRUCKS]} frustumCulled={false}>
        <boxGeometry args={[3.0, 3.5, 2.6]} />
        <meshStandardMaterial color="#e8eef5" roughness={0.5} metalness={0.2} />
      </instancedMesh>
      <instancedMesh ref={trailer} args={[undefined, undefined, MAX_TRUCKS]} frustumCulled={false}>
        <boxGeometry args={[11.5, 3.3, 2.5]} />
        <meshStandardMaterial roughness={0.45} metalness={0.15} emissive="#222" emissiveIntensity={0.3} />
      </instancedMesh>
      <instancedMesh ref={glow} args={[undefined, undefined, MAX_TRUCKS]} frustumCulled={false} renderOrder={1}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial map={glowTex} transparent depthWrite={false} blending={THREE.AdditiveBlending} opacity={0.32} toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={pick} args={[undefined, undefined, MAX_TRUCKS]} onClick={click} frustumCulled={false} onPointerOver={() => (document.body.style.cursor = "pointer")} onPointerOut={() => (document.body.style.cursor = "")}>
        <boxGeometry args={[18, 8, 9]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} colorWrite={false} />
      </instancedMesh>
      <mesh ref={ring} rotation={[-Math.PI / 2, 0, 0]} visible={false} renderOrder={2}>
        <ringGeometry args={[14, 16, 40]} />
        <meshBasicMaterial color="#ffffff" transparent opacity={0.95} depthWrite={false} toneMapped={false} />
      </mesh>
      <mesh ref={heroRing} rotation={[-Math.PI / 2, 0, 0]} visible={false} renderOrder={2}>
        <ringGeometry args={[18, 20.5, 40]} />
        <meshBasicMaterial color="#38bdf8" transparent opacity={0.95} depthWrite={false} toneMapped={false} />
      </mesh>
    </group>
  );
}

// Written by the render loop, read by the camera rig
const truckPositionRef: { current: { x: number; z: number } | null } = { current: null };
const followTargets: { current: { selected: { x: number; z: number } | null; hero: { x: number; z: number } | null } } = { current: { selected: null, hero: null } };
const controlsTarget: { current: THREE.Vector3 } = { current: new THREE.Vector3() };

export interface CameraCommand { kind: "home" | "station"; x?: number; z?: number; heading?: number; nonce: number }

function CameraRig({ command, follow }: { command: CameraCommand | null; follow: boolean }) {
  const controls = useRef<any>(null);
  const { camera } = useThree();
  const goal = useRef<{ pos: THREE.Vector3; target: THREE.Vector3 } | null>(null);
  useEffect(() => {
    camera.position.copy(HOME.pos);
  }, [camera]);
  useEffect(() => {
    if (!command) return;
    if (command.kind === "home") goal.current = { pos: HOME.pos.clone(), target: HOME.target.clone() };
    else goal.current = { pos: new THREE.Vector3(command.x! - 60, 170, command.z! + 240), target: new THREE.Vector3(command.x!, 0, command.z!) };
  }, [command]);
  useFrame((_, dt) => {
    const c = controls.current;
    if (!c) return;
    if (goal.current) {
      const k = Math.min(1, dt * 3.2);
      camera.position.lerp(goal.current.pos, k);
      c.target.lerp(goal.current.target, k);
      if (camera.position.distanceTo(goal.current.pos) < 2) goal.current = null;
    } else if (follow && truckPositionRef.current) {
      const t = truckPositionRef.current;
      const dx = t.x - c.target.x;
      const dz = t.z - c.target.z;
      const k = Math.min(1, dt * 2.2);
      c.target.x += dx * k;
      c.target.z += dz * k;
      camera.position.x += dx * k;
      camera.position.z += dz * k;
    }
    controlsTarget.current = c.target;
    c.update();
  });
  return <OrbitControls ref={controls} makeDefault target={HOME.target} enableDamping dampingFactor={0.12} maxPolarAngle={1.47} minDistance={45} maxDistance={4200} />;
}

function Gantries({ refs }: { refs: React.MutableRefObject<Record<string, THREE.MeshStandardMaterial[]>> }) {
  const frameRef = useLive.getState().frameRef;
  const colors = useMemo(() => ({ GREEN: new THREE.Color("#2fe08a"), AMBER: new THREE.Color("#ffb020"), RED: new THREE.Color("#ff4d4d") }), []);
  useFrame(() => {
    const g = frameRef.current?.gantries;
    if (!g) return;
    for (const [id, mats] of Object.entries(refs.current)) {
      const c = colors[(g[id] as keyof typeof colors) || "GREEN"] || colors.GREEN;
      for (const m of mats) {
        m.color.copy(c);
        m.emissive.copy(c);
      }
    }
  });
  return null;
}

function Labels({ network, onSelect, selected }: { network: Network; onSelect: (id: string) => void; selected: string | null }) {
  const kpi = useLive((s) => s.kpi);
  return (
    <>
      {network.plazas.map((p) => {
        const d = p.devices.control_room as Device;
        const st = kpi?.stations.find((s) => s.id === p.id);
        const q = st ? st.lane_queue + st.static_queue : 0;
        const bad = st && (!st.online || !st.edge_up || st.faults > 0);
        return (
          <Html key={p.id} position={[d.x, 22, d.z]} center zIndexRange={[20, 0]} style={{ pointerEvents: "none" }}>
            <button onClick={() => onSelect(p.id)} style={{ pointerEvents: "auto" }} className={`whitespace-nowrap cursor-pointer px-1.5 py-0.5 rounded-sm border text-[10.5px] bg-bg/85 backdrop-blur-sm ${selected === p.id ? "border-accent text-ink" : bad ? "border-wait/60 text-wait" : "border-line-2 text-ink-2 hover:text-ink"}`}>
              {p.name.replace(" (demo)", "").replace(" Screening Station", "").replace(" Weighing Station", "").replace(" Weighbridge", "").replace(" Gate-Out Node", " Gate-Out")}
              {q > 0 && <span className="num text-wait ml-1">Q{q}</span>}
              {st && !st.online && <span className="text-wait ml-1">OFFLINE</span>}
            </button>
          </Html>
        );
      })}
      {Object.entries(network.landmarks).map(([k, l]) => (
        <Html key={k} position={[l.x, 24, l.z]} center zIndexRange={[10, 0]} style={{ pointerEvents: "none" }}>
          <span className="whitespace-nowrap text-[10.5px] text-ink-3 px-1">{l.label}</span>
        </Html>
      ))}
    </>
  );
}

const StaticWorld = memo(function StaticWorld({ network, gantryRefs, onStation }: { network: Network; gantryRefs: React.MutableRefObject<Record<string, THREE.MeshStandardMaterial[]>>; onStation: (id: string) => void }) {
  return (
    <group>
      <Land />
      <PortModel />
      {network.edges.map((e) => (
        <group key={e.id}>
          <Ribbon pts={e.pts} width={e.lanes > 1 ? 15 : 9} y={0.2} color="#3a4f6b" />
          {e.lanes > 1 && <Ribbon pts={e.pts} width={0.7} y={0.25} color="#8fa3bd" />}
        </group>
      ))}
      {network.plazas.map((p) => <PlazaModel key={p.id} plaza={p} gantryRefs={gantryRefs} onSelect={onStation} />)}
    </group>
  );
});

export default function Scene({ network, selectedTruck, selectedStation, onTruck, onStation, command, follow }: { network: Network; selectedTruck: string | null; selectedStation: string | null; onTruck: (id: string) => void; onStation: (id: string) => void; command: CameraCommand | null; follow: boolean }) {
  const gantryRefs = useRef<Record<string, THREE.MeshStandardMaterial[]>>({});
  return (
    <Canvas dpr={[1, 1.5]} camera={{ fov: 38, near: 2, far: 14000, position: HOME.pos.toArray() }} gl={{ antialias: true, powerPreference: "high-performance" }} onCreated={({ gl, scene }) => { gl.setClearColor("#050a11"); scene.fog = new THREE.Fog("#050a11", 4200, 9500); }}>
      <hemisphereLight args={["#d6e4ff", "#1a2636", 1.1]} />
      <directionalLight position={[-600, 1400, 700]} intensity={1.6} color="#ffffff" />
      <StaticWorld network={network} gantryRefs={gantryRefs} onStation={onStation} />
      <Gantries refs={gantryRefs} />
      <Trucks selected={selectedTruck} onSelect={onTruck} />
      <Labels network={network} onSelect={onStation} selected={selectedStation} />
      <CameraRig command={command} follow={follow} />
    </Canvas>
  );
}
