/**
 * Read-only SVG render of an Excalidraw scene (v1). Supports rectangle, ellipse, diamond, line,
 * arrow, freedraw and text; everything else is skipped. Embedding the Excalidraw editor is left
 * for later (bundle size, and it needs a CSP-friendly build); agents and the "Edit source" view
 * change the JSON directly.
 */
import { useMemo } from 'react';
import { cn } from '@oide/ui';

interface El {
  type: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  angle?: number;
  strokeColor?: string;
  backgroundColor?: string;
  strokeWidth?: number;
  points?: Array<[number, number]>;
  text?: string;
  fontSize?: number;
  isDeleted?: boolean;
  id?: string;
}

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const color = (v: unknown, d: string) => (typeof v === 'string' && /^(#[0-9a-f]{3,8}|transparent|[a-z]+)$/i.test(v) ? v : d);

export function parseScene(json: string): { elements: El[]; background: string; error?: string } {
  try {
    const raw = JSON.parse(json) as { elements?: unknown; appState?: { viewBackgroundColor?: unknown } };
    const list = Array.isArray(raw?.elements) ? raw.elements : [];
    const elements = list
      .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object' && !(e as El).isDeleted)
      .map((e) => ({
        type: String(e.type ?? ''),
        x: num(e.x),
        y: num(e.y),
        width: num(e.width),
        height: num(e.height),
        angle: num(e.angle),
        strokeColor: color(e.strokeColor, '#C9CED6'),
        backgroundColor: color(e.backgroundColor, 'transparent'),
        strokeWidth: num(e.strokeWidth, 1.5),
        points: Array.isArray(e.points) ? (e.points as unknown[]).filter((p): p is [number, number] => Array.isArray(p) && p.length >= 2).map((p) => [num(p[0]), num(p[1])] as [number, number]) : undefined,
        text: typeof e.text === 'string' ? e.text : undefined,
        fontSize: num(e.fontSize, 16),
        id: typeof e.id === 'string' ? e.id : undefined,
      }));
    return { elements, background: color(raw?.appState?.viewBackgroundColor, '#1B1F26') };
  } catch (err) {
    return { elements: [], background: '#1B1F26', error: (err as Error).message };
  }
}

function bounds(els: El[]): { x: number; y: number; w: number; h: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const e of els) {
    const pts = e.points?.length ? e.points.map(([px, py]) => [e.x + px, e.y + py] as const) : [[e.x, e.y] as const, [e.x + (e.width || (e.text ? e.text.length * (e.fontSize ?? 16) * 0.6 : 0)), e.y + (e.height || (e.fontSize ?? 16) * 1.25)] as const];
    for (const [px, py] of pts) {
      x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py);
    }
  }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, w: 400, h: 240 };
  const pad = 16;
  return { x: x0 - pad, y: y0 - pad, w: Math.max(40, x1 - x0 + pad * 2), h: Math.max(40, y1 - y0 + pad * 2) };
}

function Shape({ e, i }: { e: El; i: number }) {
  const stroke = e.strokeColor;
  const fill = e.backgroundColor === 'transparent' ? 'none' : e.backgroundColor;
  const sw = e.strokeWidth;
  const w = e.width ?? 0;
  const h = e.height ?? 0;
  const rot = e.angle ? `rotate(${(e.angle * 180) / Math.PI} ${e.x + w / 2} ${e.y + h / 2})` : undefined;
  switch (e.type) {
    case 'rectangle':
      return <rect x={e.x} y={e.y} width={w} height={h} rx={6} stroke={stroke} fill={fill} strokeWidth={sw} transform={rot} />;
    case 'ellipse':
      return <ellipse cx={e.x + w / 2} cy={e.y + h / 2} rx={w / 2} ry={h / 2} stroke={stroke} fill={fill} strokeWidth={sw} transform={rot} />;
    case 'diamond':
      return <polygon points={`${e.x + w / 2},${e.y} ${e.x + w},${e.y + h / 2} ${e.x + w / 2},${e.y + h} ${e.x},${e.y + h / 2}`} stroke={stroke} fill={fill} strokeWidth={sw} transform={rot} />;
    case 'line':
    case 'arrow':
    case 'freedraw': {
      const pts = (e.points ?? []).map(([px, py]) => `${e.x + px},${e.y + py}`).join(' ');
      return <polyline points={pts} stroke={stroke} fill="none" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" markerEnd={e.type === 'arrow' ? `url(#wb-arrow-${i})` : undefined} />;
    }
    case 'text':
      return (
        <text x={e.x} y={e.y + (e.fontSize ?? 16)} fill={stroke} fontSize={e.fontSize} fontFamily="Inter, system-ui, sans-serif" transform={rot}>
          {(e.text ?? '').split('\n').map((line, n) => (
            <tspan key={n} x={e.x} dy={n === 0 ? 0 : (e.fontSize ?? 16) * 1.25}>
              {line}
            </tspan>
          ))}
        </text>
      );
    default:
      return null;
  }
}

export function WhiteboardSvg({ json, title, className }: { json: string; title: string; className?: string }) {
  const scene = useMemo(() => parseScene(json), [json]);
  const b = useMemo(() => bounds(scene.elements), [scene]);
  if (scene.error) return <div className={cn('flex items-center justify-center p-4 text-[12px] text-bad', className)}>Can't read this whiteboard: {scene.error}</div>;
  return (
    <svg role="img" aria-label={`Whiteboard: ${title}, ${scene.elements.length} shapes`} viewBox={`${b.x} ${b.y} ${b.w} ${b.h}`} preserveAspectRatio="xMidYMid meet" className={className} style={{ background: scene.background }}>
      <defs>
        {scene.elements.map((e, i) =>
          e.type === 'arrow' ? (
            <marker key={i} id={`wb-arrow-${i}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0 L10 5 L0 10 z" fill={e.strokeColor} />
            </marker>
          ) : null,
        )}
      </defs>
      {scene.elements.length === 0 ? (
        <text x={b.x + b.w / 2} y={b.y + b.h / 2} textAnchor="middle" fill="#6B7584" fontSize={14}>
          Empty whiteboard
        </text>
      ) : (
        scene.elements.map((e, i) => <Shape key={e.id ?? i} e={e} i={i} />)
      )}
    </svg>
  );
}
