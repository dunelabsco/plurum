"use client";

import { useEffect, useRef } from "react";

const ASCII_CHARS = ".,-~:;=!*#$@";

type Shape = "torus" | "sphere" | "cube";

interface AsciiShapeProps {
  shape?: Shape;
  cols?: number;
  rows?: number;
  className?: string;
  speed?: number;
  opacity?: string;
}

function renderTorus(
  output: string[], zbuffer: number[],
  cols: number, rows: number, A: number, B: number
) {
  const R1 = 1, R2 = 2, K2 = 5;
  const K1 = cols * K2 * 3 / (8 * (R1 + R2));
  const cosA = Math.cos(A), sinA = Math.sin(A);
  const cosB = Math.cos(B), sinB = Math.sin(B);

  for (let theta = 0; theta < 6.28; theta += 0.07) {
    const cosTheta = Math.cos(theta), sinTheta = Math.sin(theta);
    for (let phi = 0; phi < 6.28; phi += 0.02) {
      const cosPhi = Math.cos(phi), sinPhi = Math.sin(phi);
      const circleX = R2 + R1 * cosTheta;
      const circleY = R1 * sinTheta;
      const x = circleX * (cosB * cosPhi + sinA * sinB * sinPhi) - circleY * cosA * sinB;
      const y = circleX * (sinB * cosPhi - sinA * cosB * sinPhi) + circleY * cosA * cosB;
      const z = K2 + cosA * circleX * sinPhi + circleY * sinA;
      const ooz = 1 / z;
      const xp = Math.floor(cols / 2 + K1 * ooz * x);
      const yp = Math.floor(rows / 2 - K1 * ooz * y * 0.5);
      const L = cosPhi * cosTheta * sinB - cosA * cosTheta * sinPhi - sinA * sinTheta + cosB * (cosA * sinTheta - cosTheta * sinA * sinPhi);
      if (L > 0 && xp >= 0 && xp < cols && yp >= 0 && yp < rows) {
        const idx = yp * cols + xp;
        if (ooz > zbuffer[idx]) {
          zbuffer[idx] = ooz;
          output[idx] = ASCII_CHARS[Math.min(Math.floor(L * 8), ASCII_CHARS.length - 1)];
        }
      }
    }
  }
}

function renderSphere(
  output: string[], zbuffer: number[],
  cols: number, rows: number, A: number, B: number
) {
  const R = 2.2, K2 = 5;
  const K1 = cols * K2 * 3 / (8 * R * 2);
  const cosA = Math.cos(A), sinA = Math.sin(A);
  const cosB = Math.cos(B), sinB = Math.sin(B);

  for (let theta = 0; theta < 6.28; theta += 0.04) {
    const cosTheta = Math.cos(theta), sinTheta = Math.sin(theta);
    for (let phi = 0; phi < 3.14; phi += 0.03) {
      const cosPhi = Math.cos(phi), sinPhi = Math.sin(phi);
      const sx = R * sinPhi * cosTheta;
      const sy = R * sinPhi * sinTheta;
      const sz = R * cosPhi;
      // Rotate
      const x = sx * cosB - sz * sinB;
      const y2 = sx * sinB + sz * cosB;
      const y = sy * cosA - y2 * sinA;
      const z = sy * sinA + y2 * cosA + K2;
      const ooz = 1 / z;
      const xp = Math.floor(cols / 2 + K1 * ooz * x);
      const yp = Math.floor(rows / 2 - K1 * ooz * y * 0.5);
      // Simple lighting: normal dot light direction
      const nx = sinPhi * cosTheta, ny = sinPhi * sinTheta, nz = cosPhi;
      const rnx = nx * cosB - nz * sinB;
      const rny2 = nx * sinB + nz * cosB;
      const rny = ny * cosA - rny2 * sinA;
      const L = rnx * 0.5 + rny * 0.7 + (ny * sinA + rny2 * cosA) * 0.5;
      if (L > 0 && xp >= 0 && xp < cols && yp >= 0 && yp < rows) {
        const idx = yp * cols + xp;
        if (ooz > zbuffer[idx]) {
          zbuffer[idx] = ooz;
          output[idx] = ASCII_CHARS[Math.min(Math.floor(L * 10), ASCII_CHARS.length - 1)];
        }
      }
    }
  }
}

function renderCube(
  output: string[], zbuffer: number[],
  cols: number, rows: number, A: number, B: number
) {
  const size = 1.8, K2 = 6;
  const K1 = cols * K2 * 3 / (8 * size * 3);
  const cosA = Math.cos(A), sinA = Math.sin(A);
  const cosB = Math.cos(B), sinB = Math.sin(B);

  const faces = [
    { normal: [0, 0, 1], axis1: [1, 0, 0], axis2: [0, 1, 0], char_offset: 0 },
    { normal: [0, 0, -1], axis1: [-1, 0, 0], axis2: [0, 1, 0], char_offset: 2 },
    { normal: [0, 1, 0], axis1: [1, 0, 0], axis2: [0, 0, 1], char_offset: 4 },
    { normal: [0, -1, 0], axis1: [1, 0, 0], axis2: [0, 0, -1], char_offset: 1 },
    { normal: [1, 0, 0], axis1: [0, 1, 0], axis2: [0, 0, 1], char_offset: 3 },
    { normal: [-1, 0, 0], axis1: [0, -1, 0], axis2: [0, 0, 1], char_offset: 5 },
  ];

  for (const face of faces) {
    const [nx, ny, nz] = face.normal;
    const [a1x, a1y, a1z] = face.axis1;
    const [a2x, a2y, a2z] = face.axis2;

    for (let u = -1; u <= 1; u += 0.05) {
      for (let v = -1; v <= 1; v += 0.05) {
        const px = (nx + a1x * u + a2x * v) * size;
        const py = (ny + a1y * u + a2y * v) * size;
        const pz = (nz + a1z * u + a2z * v) * size;

        const rx = px * cosB - pz * sinB;
        const rz1 = px * sinB + pz * cosB;
        const ry = py * cosA - rz1 * sinA;
        const rz = py * sinA + rz1 * cosA + K2;

        const ooz = 1 / rz;
        const xp = Math.floor(cols / 2 + K1 * ooz * rx);
        const yp = Math.floor(rows / 2 - K1 * ooz * ry * 0.5);

        const rnx2 = nx * cosB - nz * sinB;
        const rnz1 = nx * sinB + nz * cosB;
        const rny2 = ny * cosA - rnz1 * sinA;
        const L = rnx2 * 0.4 + rny2 * 0.7 + (ny * sinA + rnz1 * cosA) * 0.5;

        if (L > 0 && xp >= 0 && xp < cols && yp >= 0 && yp < rows) {
          const idx = yp * cols + xp;
          if (ooz > zbuffer[idx]) {
            zbuffer[idx] = ooz;
            const ci = Math.min(Math.floor(L * 8) + face.char_offset, ASCII_CHARS.length - 1);
            output[idx] = ASCII_CHARS[Math.max(0, ci)];
          }
        }
      }
    }
  }
}

export function AsciiShape({ shape = "torus", cols = 50, rows = 28, className = "", speed = 1, opacity = "0.12" }: AsciiShapeProps) {
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const pre = preRef.current;
    if (!pre) return;

    let A = Math.random() * 6.28;
    let B = Math.random() * 6.28;
    let animationId: number;

    const renderFn = shape === "sphere" ? renderSphere : shape === "cube" ? renderCube : renderTorus;

    const render = () => {
      const output = new Array(cols * rows).fill(" ");
      const zbuffer = new Array(cols * rows).fill(0);

      renderFn(output, zbuffer, cols, rows, A, B);

      let result = "";
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          result += output[j * cols + i];
        }
        result += "\n";
      }
      pre.textContent = result;

      A += 0.02 * speed;
      B += 0.015 * speed;
      animationId = requestAnimationFrame(render);
    };

    animationId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animationId);
  }, [shape, cols, rows, speed]);

  return (
    <pre
      ref={preRef}
      className={`font-display leading-[1.05] pointer-events-none select-none ${className}`}
      style={{ fontSize: "clamp(5px, 0.7vw, 9px)", letterSpacing: "0.05em", opacity }}
    />
  );
}
