// Эффект eye-dome lighting (как в Potree): облако рисуется непрозрачными точками в буфер
// «цвет + log-глубина», затем полноэкранный проход затемняет точки, за которыми сосед ближе.
// Получаются контуры и объём без нормалей — облако читается как рельеф, а не как пыль.
import * as THREE from 'three';

const QUAD_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const EDL_FRAG = /* glsl */ `
  uniform sampler2D tColor;
  uniform vec2 uTexel;
  uniform float uRadius;
  uniform float uStrength;
  uniform float uFloor;     // минимум затенения: контуры есть, дальний план не гаснет
  uniform float uExposure;
  uniform float uOverlay;   // 1 — поверх кадра: фон прозрачный
  uniform float uVignette;
  uniform float uGrain;
  uniform float uTime;
  varying vec2 vUv;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

  void main() {
    vec4 c = texture2D(tColor, vUv);
    float d = c.a;                                   // log2(1 + глубина), 0 — пусто
    float sum = 0.0;
    for (int i = 0; i < 8; i++) {
      float a = float(i) * 0.78539816;
      float nd = texture2D(tColor, vUv + vec2(cos(a), sin(a)) * uRadius * uTexel).a;
      if (nd > 0.0) sum += d > 0.0 ? max(0.0, d - nd) : 100.0;
    }
    float shade = mix(uFloor, 1.0, exp(-(sum / 8.0) * 300.0 * uStrength));
    vec3 col = c.rgb * shade * uExposure;
    float alpha = d > 0.0 || sum > 0.0 ? 1.0 : 0.0;
    if (uOverlay > 0.5) {
      if (alpha == 0.0) discard;
      gl_FragColor = vec4(col, 1.0);
      return;
    }
    vec2 q = vUv - 0.5;
    col *= 1.0 - uVignette * dot(q, q) * 2.2;
    col += (hash(vUv * 1024.0 + uTime) - 0.5) * uGrain;
    gl_FragColor = vec4(max(col, 0.0), 1.0);
  }
`;

export interface ComposeOptions {
  overlay?: boolean; // поверх уже нарисованного (детальный скан)
  exposure?: number; // 0 — чёрный экран (глаза закрыты)
  strength?: number;
  radius?: number; // пикс. CSS
  floor?: number; // 0..1, минимум затенения точки
  time?: number;
}

export class PointComposer {
  private rt: THREE.WebGLRenderTarget;
  private quad: THREE.Mesh;
  private quadScene = new THREE.Scene();
  private quadCam = new THREE.Camera();
  private mat: THREE.ShaderMaterial;
  private size = new THREE.Vector2();

  constructor() {
    this.rt = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      generateMipmaps: false,
    });
    this.mat = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT,
      fragmentShader: EDL_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tColor: { value: this.rt.texture },
        uTexel: { value: new THREE.Vector2(1, 1) },
        uRadius: { value: 1.4 },
        uStrength: { value: 0.6 },
        uFloor: { value: 0.3 },
        uExposure: { value: 1 },
        uOverlay: { value: 0 },
        uVignette: { value: 0.55 },
        uGrain: { value: 0.018 },
        uTime: { value: 0 },
      },
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, o: ComposeOptions = {}): void {
    renderer.getDrawingBufferSize(this.size);
    if (this.rt.width !== this.size.x || this.rt.height !== this.size.y) this.rt.setSize(this.size.x, this.size.y);
    const prevTarget = renderer.getRenderTarget();
    const prevColor = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    const prevAuto = renderer.autoClear;

    renderer.setRenderTarget(this.rt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, false);
    renderer.render(scene, camera);
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevColor, prevAlpha);

    const u = this.mat.uniforms;
    u.uTexel.value.set(1 / this.size.x, 1 / this.size.y);
    u.uRadius.value = (o.radius ?? 1.4) * renderer.getPixelRatio();
    u.uStrength.value = o.strength ?? 0.6;
    u.uFloor.value = o.floor ?? 0.3;
    u.uExposure.value = o.exposure ?? 1;
    u.uOverlay.value = o.overlay ? 1 : 0;
    u.uTime.value = (o.time ?? 0) % 1000;
    renderer.autoClear = false;
    if (!o.overlay) renderer.clear(true, true, false);
    renderer.render(this.quadScene, this.quadCam);
    renderer.autoClear = prevAuto;
  }

  dispose(): void {
    this.rt.dispose();
    this.mat.dispose();
    this.quad.geometry.dispose();
  }
}
