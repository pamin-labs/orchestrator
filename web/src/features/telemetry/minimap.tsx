/**
 * Where in the whole stretch the view is, and a handle to drag it.
 *
 * Its own file because both charts render it — the flamegraph against its own
 * width, the trend against the window — and a shared control imported out of one
 * feature's `view.tsx` into another's is how an import cycle starts.
 */
import { panTo, type TimeWindow } from "./model";

/**
 * Where you are, once you are no longer looking at all of it.
 *
 * A strip of the whole extent with the current view on it, draggable to pan.
 * Drawn against the *extent* and not the rendered rows, which is why a `recharts`
 * `Brush` cannot serve: a zoom here re-reads the endpoint, so those rows *are* the
 * window. Shown only once there is something to be lost.
 */
export function Minimap({
  view,
  limit,
  label,
  onPan,
}: {
  view: TimeWindow;
  limit: TimeWindow;
  label: string;
  onPan: (next: TimeWindow) => void;
}) {
  const whole = limit.to - limit.from;
  const span = view.to - view.from;
  if (whole <= 0 || span >= whole) return null;
  /** Centre the window where the pointer is, in the limit's own units. */
  const panFrom = (event: React.PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width === 0) return;
    const at = (event.clientX - box.left) / box.width;
    if (Number.isFinite(at)) onPan(panTo(view, limit.from + at * whole, limit));
  };
  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(((view.from - limit.from) / whole) * 100)}
      className="h-2 cursor-ew-resize rounded-sm bg-sunk"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        panFrom(event);
      }}
      onPointerMove={(event) => {
        if (event.buttons === 1) panFrom(event);
      }}
    >
      <div
        className="h-full rounded-sm bg-ink-3"
        style={{ marginLeft: `${((view.from - limit.from) / whole) * 100}%`, width: `${(span / whole) * 100}%` }}
      />
    </div>
  );
}
