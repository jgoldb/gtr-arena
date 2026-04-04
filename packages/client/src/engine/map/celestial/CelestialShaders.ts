import * as THREE from 'three';

/**
 * Diamond shader — mostly transparent with prismatic sparkle and fresnel edges.
 * Used for the diamond archway tubes and base mounds.
 */
export function createDiamondShaderMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: `
      varying vec3 vNormal;
      varying vec3 vViewPosition;
      varying vec3 vWorldPosition;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
        vViewPosition = -mvPos.xyz;
        vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * mvPos;
      }
    `,
    fragmentShader: `
      uniform float uTime;
      varying vec3 vNormal;
      varying vec3 vViewPosition;
      varying vec3 vWorldPosition;

      float hash3(vec3 p) {
        return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
      }
      float noise3(vec3 p) {
        vec3 i = floor(p);
        vec3 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(mix(hash3(i), hash3(i+vec3(1,0,0)), f.x),
              mix(hash3(i+vec3(0,1,0)), hash3(i+vec3(1,1,0)), f.x), f.y),
          mix(mix(hash3(i+vec3(0,0,1)), hash3(i+vec3(1,0,1)), f.x),
              mix(hash3(i+vec3(0,1,1)), hash3(i+vec3(1,1,1)), f.x), f.y),
          f.z);
      }

      void main() {
        vec3 V = normalize(vViewPosition);
        float fresnel = pow(1.0 - abs(dot(vNormal, V)), 3.0);

        // Prismatic rainbow dispersion based on view angle
        float ang = dot(vNormal, V) * 6.0 + uTime * 0.3;
        vec3 rainbow = vec3(
          sin(ang) * 0.5 + 0.5,
          sin(ang + 2.094) * 0.5 + 0.5,
          sin(ang + 4.189) * 0.5 + 0.5
        );

        // Animated sparkle highlights across the surface
        float sp = smoothstep(0.92, 0.96, noise3(vWorldPosition * 8.0 + uTime * 1.5))
                 + smoothstep(0.94, 0.97, noise3(vWorldPosition * 15.0 - uTime * 2.0)) * 0.7;

        // Clear diamond body with cool tint, prismatic edges
        vec3 color = mix(vec3(0.88, 0.93, 1.0), mix(vec3(1.0), rainbow, 0.6), fresnel * 0.8);
        color += sp * vec3(1.0, 0.98, 0.95) * 2.5 + rainbow * fresnel * 0.3;

        gl_FragColor = vec4(color, 0.12 + fresnel * 0.5 + sp * 0.6);
      }
    `,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
}

/** Plasma shader material (shared between walls and bubbles). */
export function createPlasmaShaderMaterial(opacity: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uOpacity: { value: opacity },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform float uOpacity;
      varying vec2 vUv;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
      }

      float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
          mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
          f.y
        );
      }

      void main() {
        vec2 uv = vUv;

        float n1 = noise(uv * 5.0 + vec2(uTime * 0.3, uTime * 0.5));
        float n2 = noise(uv * 8.0 + vec2(-uTime * 0.4, uTime * 0.25));
        float n3 = noise(uv * 3.0 + vec2(uTime * 0.15, -uTime * 0.35));
        float n = n1 * 0.4 + n2 * 0.35 + n3 * 0.25;

        float hueShift = uTime * 0.2;
        float r = sin(hueShift + n * 4.0) * 0.5 + 0.5;
        float g = sin(hueShift + n * 4.0 + 2.094) * 0.5 + 0.5;
        float b = sin(hueShift + n * 4.0 + 4.189) * 0.5 + 0.5;

        vec3 color = vec3(r, g, b) * 1.3;

        float alpha = (0.4 + 0.4 * n) * uOpacity;

        gl_FragColor = vec4(color, alpha);
      }
    `,
    transparent: true,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
}
